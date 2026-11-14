"""Settings saved in the local database (settings table).

Shopify details belong to an account. The admin (and listings made before accounts existed) use
the plain keys, which fall back to .env, exactly as before. A signed-in user gets keys prefixed with
their id and no .env fallback, so a user can never push to the admin's store.
"""
from __future__ import annotations

import contextvars
import hashlib
import hmac
import json
import re
import secrets
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone

from . import config, db

# None: the admin / global workspace. Otherwise a user id.
current_owner: contextvars.ContextVar[str | None] = contextvars.ContextVar("pla_owner", default=None)
# The store a running push is fixed to, so switching the active store never changes a push that already started.
current_store: contextvars.ContextVar[str | None] = contextvars.ContextVar("pla_store", default=None)

ENV_NAME = {
    "shopify_domain": "SHOPIFY_STORE_DOMAIN",
    "shopify_client_id": "SHOPIFY_CLIENT_ID",
    "shopify_client_secret": "SHOPIFY_CLIENT_SECRET",
    "shopify_admin_token": "SHOPIFY_ADMIN_TOKEN",
}
SHOPIFY_KEYS = ["shopify_method", *ENV_NAME.keys()]


def _scoped(key: str, owner: str | None) -> str:
    return key if owner is None else f"u:{owner}:{key}"


def read_setting(key: str) -> str:
    row = db.one("SELECT value FROM settings WHERE key = ?", (key,))
    return row["value"] if row else ""


def write_setting(key: str, value: str) -> None:
    db.execute("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value))


def _read_saved(key: str) -> str:
    return read_setting(_scoped(key, current_owner.get()))


def normalize_domain(value: str) -> str:
    host = re.sub(r"^https?://", "", value.strip(), flags=re.I)
    host = re.sub(r"[/?#].*$", "", host).lower()
    if not host:
        return ""
    return host if "." in host else f"{host}.myshopify.com"


def is_valid_domain(domain: str) -> bool:
    return bool(re.match(r"^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)*\.[a-z]{2,}$", domain))


def shopify_credentials() -> dict:
    owner = current_owner.get()
    if owner is not None:
        row = active_store(owner)
        if row:
            return {"method": row["method"], "domain": row["domain"], "clientId": row["client_id"], "clientSecret": row["client_secret"], "adminToken": row["admin_token"]}
        return {"method": "client", "domain": "", "clientId": "", "clientSecret": "", "adminToken": ""}

    def value(key: str) -> str:
        saved = _read_saved(key)
        if saved or owner is not None:
            return saved
        return config.env(ENV_NAME[key])

    admin_token = value("shopify_admin_token").strip()
    chosen = _read_saved("shopify_method")
    method = chosen if chosen in ("token", "client") else ("token" if admin_token else "client")
    return {
        "method": method,
        "domain": normalize_domain(value("shopify_domain")),
        "clientId": value("shopify_client_id").strip(),
        "clientSecret": value("shopify_client_secret").strip(),
        "adminToken": admin_token,
    }


def save_shopify_credentials(*, method: str | None, domain: str, client_id: str | None = None, client_secret: str | None = None, admin_token: str | None = None) -> None:
    owner = current_owner.get()
    if owner is not None:
        # The single-store form: changes the active store, or connects the first one.
        row = active_store(owner)
        if row:
            update_store(owner, row["id"], method=method, domain=domain, client_id=client_id, client_secret=client_secret, admin_token=admin_token)
        else:
            activate_store(owner, add_store(owner, method=method, domain=domain, client_id=client_id, client_secret=client_secret, admin_token=admin_token)["id"])
        return
    method = "token" if method == "token" else "client"
    with db.transaction():
        write_setting(_scoped("shopify_method", owner), method)
        write_setting(_scoped("shopify_domain", owner), normalize_domain(domain))
        if method == "token":
            if (admin_token or "").strip():
                write_setting(_scoped("shopify_admin_token", owner), admin_token.strip())
            return
        write_setting(_scoped("shopify_client_id", owner), (client_id or "").strip())
        if (client_secret or "").strip():
            write_setting(_scoped("shopify_client_secret", owner), client_secret.strip())


def clear_shopify_credentials() -> None:
    owner = current_owner.get()
    if owner is not None:
        row = active_store(owner)
        if row:
            remove_store(owner, row["id"])
        return
    keys = [_scoped(k, owner) for k in SHOPIFY_KEYS]
    db.execute(f"DELETE FROM settings WHERE key IN ({', '.join('?' * len(keys))})", keys)


def shopify_summary() -> dict:
    creds = shopify_credentials()
    if current_owner.get() is not None:
        return {
            "method": creds["method"],
            "domain": creds["domain"],
            "clientId": creds["clientId"],
            "hasSecret": bool(creds["clientSecret"]),
            "hasAdminToken": bool(creds["adminToken"]),
            "source": "page" if creds["domain"] else "none",
        }
    saved_here = any(_read_saved(key) for key in SHOPIFY_KEYS)
    any_value = creds["domain"] or creds["clientId"] or creds["clientSecret"] or creds["adminToken"]
    return {
        "method": creds["method"],
        "domain": creds["domain"],
        "clientId": creds["clientId"],
        "hasSecret": bool(creds["clientSecret"]),
        "hasAdminToken": bool(creds["adminToken"]),
        "source": "page" if saved_here else ("env" if any_value else "none"),
    }


# ---------- Which SerpAPI key is in use (admin only) ----------

def serp_preference() -> dict:
    return {"active": 2 if read_setting("serp_active") == "2" else 1, "auto": read_setting("serp_auto") != "0"}


def save_serp_preference(active: int | None = None, auto: bool | None = None) -> dict:
    current = serp_preference()
    active = active if active in (1, 2) else current["active"]
    auto = auto if isinstance(auto, bool) else current["auto"]
    write_setting("serp_active", str(active))
    write_setting("serp_auto", "1" if auto else "0")
    return {"active": active, "auto": auto}


# ---------- The product page new products get ----------

DEFAULT_TEMPLATE_ID = "saamano"


def default_template_id() -> str:
    """The template (a key of pla/templates.py) that products pushed to the active store use. One choice per store."""
    return _read_saved(f"default_template:{shopify_credentials()['domain']}") or DEFAULT_TEMPLATE_ID


def save_default_template(template_id: str) -> None:
    write_setting(_scoped(f"default_template:{shopify_credentials()['domain']}", current_owner.get()), template_id)


# ---------- Last theme template push ----------

def _push_key(template_id: str) -> str:
    return f"template_push:{template_id}:{shopify_credentials()['domain']}"


def last_template_push(template_id: str) -> dict | None:
    raw = _read_saved(_push_key(template_id)) or _read_saved(f"template_push:{template_id}")
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return None


def save_template_push(template_id: str, push: dict) -> None:
    write_setting(_scoped(_push_key(template_id), current_owner.get()), json.dumps(push))


# ---------- Saamano page text written by the AI ----------

def saved_product_story(product_id: str) -> dict | None:
    raw = read_setting(f"story:{product_id}")
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return None


def save_product_story(product_id: str, story: dict) -> None:
    write_setting(f"story:{product_id}", json.dumps(story))


# ---------- Public link to the uploaded photo (for Google Lens) ----------

def _link_secret() -> str:
    existing = read_setting("link_secret")
    if existing:
        return existing
    db.execute("INSERT INTO settings (key, value) VALUES ('link_secret', ?) ON CONFLICT DO NOTHING", (secrets.token_hex(32),))
    return read_setting("link_secret")


def photo_token(product_id: str) -> str:
    return hmac.new(_link_secret().encode(), f"photo:{product_id}".encode(), hashlib.sha256).hexdigest()


def photo_token_valid(product_id: str, token: str) -> bool:
    if not re.match(r"^[a-f0-9]{64}$", token or ""):
        return False
    return hmac.compare_digest(photo_token(product_id), token)


def fastmoss_api_key() -> str:
    return config.env("FASTMOSS_API_KEY")


def public_photo_url(product_id: str) -> str:
    base = config.public_base_url()
    return f"{base}/api/public-photo/{product_id}/{photo_token(product_id)}.jpg" if base else ""


# ---------- Shopify stores of a signed-in user ----------

_stamp_lock = threading.Lock()
_last_stamp = 0


def _now() -> str:
    """The time in microseconds, and never the same twice: Windows' clock ticks in milliseconds, and stores
    added one after the other must keep the order they were added in."""
    global _last_stamp
    with _stamp_lock:
        _last_stamp = max(int(time.time() * 1_000_000), _last_stamp + 1)
        moment = datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(microseconds=_last_stamp)
    return moment.isoformat(timespec="microseconds").replace("+00:00", "Z")


def _active_key(owner: str) -> str:
    return f"u:{owner}:active_store"


def _adopt_single_store(owner: str) -> None:
    """A user who connected a store before stores had a list: that store becomes the first row."""
    if db.one("SELECT 1 AS x FROM shopify_stores WHERE owner_id = ? LIMIT 1", (owner,)):
        return
    old = {key: read_setting(_scoped(key, owner)) for key in SHOPIFY_KEYS}
    domain = normalize_domain(old["shopify_domain"])
    if not domain:
        return
    store_id = str(uuid.uuid4())
    db.execute(
        "INSERT INTO shopify_stores (id, owner_id, domain, method, client_id, client_secret, admin_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
        (store_id, owner, domain, "token" if old["shopify_method"] == "token" else "client", old["shopify_client_id"].strip(), old["shopify_client_secret"].strip(), old["shopify_admin_token"].strip(), _now()),
    )
    write_setting(_active_key(owner), store_id)
    keys = [_scoped(key, owner) for key in SHOPIFY_KEYS]
    db.execute(f"DELETE FROM settings WHERE key IN ({', '.join('?' * len(keys))})", keys)


def list_stores(owner: str) -> list[dict]:
    _adopt_single_store(owner)
    return db.all_rows("SELECT * FROM shopify_stores WHERE owner_id = ? ORDER BY created_at, id", (owner,))


def active_store(owner: str) -> dict | None:
    rows = list_stores(owner)
    if not rows:
        return None
    wanted = current_store.get() or read_setting(_active_key(owner))
    return next((row for row in rows if row["id"] == wanted), rows[0])


def pin_active_store() -> None:
    """Fixes the running work to the store that is active now."""
    owner = current_owner.get()
    if owner is None:
        return
    row = active_store(owner)
    current_store.set(row["id"] if row else None)


def public_store(row: dict, active_id: str | None) -> dict:
    return {
        "id": row["id"],
        "domain": row["domain"],
        "method": row["method"],
        "clientId": row["client_id"],
        "hasSecret": bool(row["client_secret"]),
        "hasAdminToken": bool(row["admin_token"]),
        "active": row["id"] == active_id,
        "createdAt": row["created_at"],
    }


class StoreError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


def get_store(owner: str, store_id: str) -> dict | None:
    return next((row for row in list_stores(owner) if row["id"] == store_id), None)


def add_store(owner: str, *, method: str | None, domain: str, client_id: str | None = None, client_secret: str | None = None, admin_token: str | None = None) -> dict:
    domain = normalize_domain(domain)
    if any(row["domain"] == domain for row in list_stores(owner)):
        raise StoreError(f"{domain} is already connected.", 409)
    store_id = str(uuid.uuid4())
    db.execute(
        "INSERT INTO shopify_stores (id, owner_id, domain, method, client_id, client_secret, admin_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (store_id, owner, domain, "token" if method == "token" else "client", (client_id or "").strip(), (client_secret or "").strip(), (admin_token or "").strip(), _now()),
    )
    return get_store(owner, store_id)


def update_store(owner: str, store_id: str, *, method: str | None, domain: str, client_id: str | None = None, client_secret: str | None = None, admin_token: str | None = None) -> dict:
    row = get_store(owner, store_id)
    if not row:
        raise StoreError("Store not found.", 404)
    domain = normalize_domain(domain)
    if any(other["domain"] == domain and other["id"] != store_id for other in list_stores(owner)):
        raise StoreError(f"{domain} is already connected.", 409)
    method = "token" if method == "token" else "client"
    # A blank secret or token keeps the saved one.
    secret = (client_secret or "").strip() or row["client_secret"]
    token = (admin_token or "").strip() or row["admin_token"]
    db.execute(
        "UPDATE shopify_stores SET domain = ?, method = ?, client_id = ?, client_secret = ?, admin_token = ? WHERE id = ? AND owner_id = ?",
        (domain, method, (client_id or "").strip() if method == "client" else row["client_id"], secret, token, store_id, owner),
    )
    return get_store(owner, store_id)


def remove_store(owner: str, store_id: str) -> None:
    if not get_store(owner, store_id):
        raise StoreError("Store not found.", 404)
    db.execute("DELETE FROM shopify_stores WHERE id = ? AND owner_id = ?", (store_id, owner))
    if read_setting(_active_key(owner)) == store_id:
        write_setting(_active_key(owner), "")


def activate_store(owner: str, store_id: str) -> None:
    if not get_store(owner, store_id):
        raise StoreError("Store not found.", 404)
    write_setting(_active_key(owner), store_id)

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

from . import config, db

# None: the admin / global workspace. Otherwise a user id.
current_owner: contextvars.ContextVar[str | None] = contextvars.ContextVar("pla_owner", default=None)

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
    keys = [_scoped(k, owner) for k in SHOPIFY_KEYS]
    db.execute(f"DELETE FROM settings WHERE key IN ({', '.join('?' * len(keys))})", keys)


def shopify_summary() -> dict:
    creds = shopify_credentials()
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


# ---------- Last theme template push ----------

def last_template_push(template_id: str) -> dict | None:
    raw = _read_saved(f"template_push:{template_id}")
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return None


def save_template_push(template_id: str, push: dict) -> None:
    write_setting(_scoped(f"template_push:{template_id}", current_owner.get()), json.dumps(push))


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

"""Accounts, plans, billing requests and the search allowance.

- Users sign up and log in. A new user gets FREE_SEARCHES (2) searches.
- One search = one product sent for research (Add new listing).
- The admin logs in with ADMIN_EMAIL / ADMIN_PASSWORD from .env. There is no admin sign-up.
- A user asks for a plan on the Billing page. The admin approves it and decides how many searches to give.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
import time
import uuid

from . import config, db
from .repo import now

FREE_SEARCHES = 2
SESSION_DAYS = 14
ADMIN_ID = "admin"

ACCOUNT_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  searches_allowed INTEGER NOT NULL DEFAULT 0,
  searches_used INTEGER NOT NULL DEFAULT 0,
  plan_id TEXT,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price TEXT NOT NULL,
  searches INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS billing_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL,
  plan_name TEXT NOT NULL,
  price TEXT NOT NULL,
  searches_requested INTEGER NOT NULL,
  payment_note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  searches_granted INTEGER,
  admin_note TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE TABLE IF NOT EXISTS search_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  product_id TEXT,
  change INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
"""

DEFAULT_PLANS = [
    {"id": "starter", "name": "Starter", "price": "Rs 1,000 / month", "searches": 25, "description": "For trying the app with a few products.", "position": 0},
    {"id": "pro", "name": "Pro", "price": "Rs 2,500 / month", "searches": 75, "description": "For a store that lists products every week.", "position": 1},
    {"id": "business", "name": "Business", "price": "Rs 6,000 / month", "searches": 200, "description": "For teams that list many products every day.", "position": 2},
]

_ready_path: str | None = None


def ensure_schema() -> None:
    global _ready_path
    path = config.data_dir()
    if _ready_path == path:
        return
    db.ensure_sqlite_tables(ACCOUNT_SCHEMA)
    if not db.one("SELECT 1 AS x FROM plans LIMIT 1"):
        with db.transaction() as connection:
            for plan in DEFAULT_PLANS:
                connection.execute(
                    "INSERT INTO plans (id, name, price, searches, description, position, active) VALUES (?, ?, ?, ?, ?, ?, 1)",
                    (plan["id"], plan["name"], plan["price"], plan["searches"], plan["description"], plan["position"]),
                )
    _ready_path = path


class AccountError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


# ---------- Passwords ----------

def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return "scrypt$" + base64.b64encode(salt).decode() + "$" + base64.b64encode(digest).decode()


def verify_password(password: str, stored: str) -> bool:
    try:
        _, salt_b64, digest_b64 = stored.split("$")
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(digest_b64)
    except ValueError:
        return False
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=len(expected))
    return hmac.compare_digest(digest, expected)


# ---------- Session tokens ----------

def _secret() -> bytes:
    """AUTH_SECRET from .env, or a random one kept in the database so sessions survive restarts."""
    configured = config.env("AUTH_SECRET")
    if configured:
        return configured.encode()
    row = db.one("SELECT value FROM settings WHERE key = 'auth_secret'")
    if row:
        return row["value"].encode()
    db.execute("INSERT INTO settings (key, value) VALUES ('auth_secret', ?) ON CONFLICT DO NOTHING", (secrets.token_hex(32),))
    return db.one("SELECT value FROM settings WHERE key = 'auth_secret'")["value"].encode()


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def make_token(subject: str, role: str) -> str:
    payload = _b64(json.dumps({"sub": subject, "role": role, "exp": int(time.time()) + SESSION_DAYS * 86400}, separators=(",", ":")).encode())
    signature = _b64(hmac.new(_secret(), payload.encode(), hashlib.sha256).digest())
    return f"{payload}.{signature}"


def read_token(token: str | None) -> dict | None:
    if not token or "." not in token:
        return None
    payload, signature = token.rsplit(".", 1)
    expected = _b64(hmac.new(_secret(), payload.encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(expected, signature):
        return None
    try:
        data = json.loads(_unb64(payload))
    except ValueError:
        return None
    if not isinstance(data, dict) or data.get("exp", 0) < time.time():
        return None
    return data


# ---------- Who is signed in ----------

def admin_email() -> str:
    return config.env("ADMIN_EMAIL").lower()


def admin_configured() -> bool:
    return bool(admin_email() and config.env("ADMIN_PASSWORD"))


def session_user(token: str | None) -> dict | None:
    """The signed-in account, re-read from the database so a blocked user is stopped at once."""
    data = read_token(token)
    if not data:
        return None
    if data.get("role") == "admin":
        if not admin_configured():
            return None
        return {"id": ADMIN_ID, "role": "admin", "email": admin_email(), "name": "Admin"}
    ensure_schema()
    user = db.one("SELECT * FROM users WHERE id = ?", (data.get("sub"),))
    if not user or user["status"] != "active":
        return None
    return {**public_user(user), "role": "user"}


def public_user(row: dict) -> dict:
    allowed = int(row["searches_allowed"])
    used = int(row["searches_used"])
    return {
        "id": row["id"],
        "email": row["email"],
        "name": row["name"],
        "status": row["status"],
        "searchesAllowed": allowed,
        "searchesUsed": used,
        "searchesLeft": max(0, allowed - used),
        "planId": row.get("plan_id"),
        "createdAt": row["created_at"],
        "lastLoginAt": row.get("last_login_at"),
    }


EMAIL = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def sign_up(name: str, email: str, password: str) -> dict:
    ensure_schema()
    name = re.sub(r"\s+", " ", name or "").strip()[:80]
    email = (email or "").strip().lower()
    if not name:
        raise AccountError("Enter your name.")
    if not EMAIL.match(email) or len(email) > 200:
        raise AccountError("Enter a valid email address.")
    if len(password or "") < 8:
        raise AccountError("The password must be at least 8 characters.")
    if len(password) > 200:
        raise AccountError("The password is too long.")
    if email == admin_email():
        raise AccountError("This email cannot be used for a new account.")
    if db.one("SELECT 1 AS x FROM users WHERE email = ?", (email,)):
        raise AccountError("An account with this email already exists. Log in instead.", 409)
    user_id = str(uuid.uuid4())
    stamp = now()
    with db.transaction() as connection:
        connection.execute(
            "INSERT INTO users (id, email, name, password_hash, status, searches_allowed, searches_used, created_at, last_login_at) VALUES (?, ?, ?, ?, 'active', ?, 0, ?, ?)",
            (user_id, email, name, hash_password(password), FREE_SEARCHES, stamp, stamp),
        )
        connection.execute(
            "INSERT INTO search_log (id, user_id, product_id, change, reason, created_at) VALUES (?, ?, NULL, ?, 'Free searches on sign-up', ?)",
            (str(uuid.uuid4()), user_id, FREE_SEARCHES, stamp),
        )
    return public_user(db.one("SELECT * FROM users WHERE id = ?", (user_id,)))


def log_in(email: str, password: str) -> dict:
    ensure_schema()
    email = (email or "").strip().lower()
    user = db.one("SELECT * FROM users WHERE email = ?", (email,))
    if not user or not verify_password(password or "", user["password_hash"]):
        raise AccountError("Wrong email or password.", 401)
    if user["status"] != "active":
        raise AccountError("This account is blocked. Contact the admin.", 403)
    db.execute("UPDATE users SET last_login_at = ? WHERE id = ?", (now(), user["id"]))
    return public_user(db.one("SELECT * FROM users WHERE id = ?", (user["id"],)))


def admin_log_in(email: str, password: str) -> None:
    if not admin_configured():
        raise AccountError("The admin login is not set up. Add ADMIN_EMAIL and ADMIN_PASSWORD to backend/.env and restart the backend.", 503)
    ok_email = hmac.compare_digest((email or "").strip().lower(), admin_email())
    ok_password = hmac.compare_digest((password or "").encode(), config.env("ADMIN_PASSWORD").encode())
    if not (ok_email and ok_password):
        raise AccountError("Wrong admin email or password.", 401)


# ---------- Searches ----------

def consume_search(user_id: str, product_id: str) -> None:
    """Takes one search, atomically. Raises when none are left."""
    ensure_schema()
    with db.transaction() as connection:
        cursor = connection.execute(
            "UPDATE users SET searches_used = searches_used + 1 WHERE id = ? AND status = 'active' AND searches_used < searches_allowed",
            (user_id,),
        )
        if cursor.rowcount != 1:
            raise AccountError("You have no searches left. Open Billing to choose a plan.", 402)
        connection.execute(
            "INSERT INTO search_log (id, user_id, product_id, change, reason, created_at) VALUES (?, ?, ?, -1, 'Product search', ?)",
            (str(uuid.uuid4()), user_id, product_id, now()),
        )


def refund_search(user_id: str, product_id: str) -> None:
    """Gives the search back when the product could not be created."""
    with db.transaction() as connection:
        connection.execute("UPDATE users SET searches_used = CASE WHEN searches_used > 0 THEN searches_used - 1 ELSE 0 END WHERE id = ?", (user_id,))
        connection.execute(
            "INSERT INTO search_log (id, user_id, product_id, change, reason, created_at) VALUES (?, ?, ?, 1, 'Search returned: the product could not be created', ?)",
            (str(uuid.uuid4()), user_id, product_id, now()),
        )


def user_overview(user_id: str) -> dict:
    ensure_schema()
    user = db.one("SELECT * FROM users WHERE id = ?", (user_id,))
    if not user:
        raise AccountError("Account not found.", 404)
    history = db.all_rows("SELECT change, reason, created_at FROM search_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 50", (user_id,))
    return {"user": public_user(user), "history": history}


# ---------- Plans ----------

def list_plans(include_inactive: bool = False) -> list[dict]:
    ensure_schema()
    rows = db.all_rows("SELECT * FROM plans" + ("" if include_inactive else " WHERE active = 1") + " ORDER BY position, name")
    return [{**r, "active": bool(r["active"])} for r in rows]


def update_plan(plan_id: str, fields: dict) -> dict:
    ensure_schema()
    plan = db.one("SELECT * FROM plans WHERE id = ?", (plan_id,))
    if not plan:
        raise AccountError("Plan not found.", 404)
    name = re.sub(r"\s+", " ", str(fields.get("name", plan["name"]))).strip()[:60]
    price = re.sub(r"\s+", " ", str(fields.get("price", plan["price"]))).strip()[:60]
    description = str(fields.get("description", plan["description"])).strip()[:300]
    try:
        searches = int(fields.get("searches", plan["searches"]))
    except (TypeError, ValueError):
        raise AccountError("Searches must be a whole number.") from None
    if not name or not price:
        raise AccountError("A plan needs a name and a price.")
    if searches < 1 or searches > 100_000:
        raise AccountError("Searches must be between 1 and 100000.")
    active = bool(fields.get("active", bool(plan["active"])))
    db.execute("UPDATE plans SET name = ?, price = ?, searches = ?, description = ?, active = ? WHERE id = ?", (name, price, searches, description, int(active), plan_id))
    return {**db.one("SELECT * FROM plans WHERE id = ?", (plan_id,)), "active": active}


# ---------- Billing requests ----------

def _public_request(row: dict) -> dict:
    return {
        "id": row["id"],
        "userId": row["user_id"],
        "planId": row["plan_id"],
        "planName": row["plan_name"],
        "price": row["price"],
        "searchesRequested": row["searches_requested"],
        "paymentNote": row["payment_note"],
        "status": row["status"],
        "searchesGranted": row["searches_granted"],
        "adminNote": row["admin_note"],
        "createdAt": row["created_at"],
        "decidedAt": row["decided_at"],
        **({"userEmail": row["user_email"], "userName": row["user_name"]} if "user_email" in row else {}),
    }


def request_plan(user_id: str, plan_id: str, payment_note: str) -> dict:
    ensure_schema()
    plan = db.one("SELECT * FROM plans WHERE id = ? AND active = 1", (plan_id,))
    if not plan:
        raise AccountError("Choose one of the plans.")
    if db.one("SELECT 1 AS x FROM billing_requests WHERE user_id = ? AND status = 'pending'", (user_id,)):
        raise AccountError("You already have a request waiting for the admin. Wait until it is approved or rejected.", 409)
    request_id = str(uuid.uuid4())
    db.execute(
        "INSERT INTO billing_requests (id, user_id, plan_id, plan_name, price, searches_requested, payment_note, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
        (request_id, user_id, plan["id"], plan["name"], plan["price"], plan["searches"], (payment_note or "").strip()[:500], now()),
    )
    return _public_request(db.one("SELECT * FROM billing_requests WHERE id = ?", (request_id,)))


def user_requests(user_id: str) -> list[dict]:
    ensure_schema()
    return [_public_request(r) for r in db.all_rows("SELECT * FROM billing_requests WHERE user_id = ? ORDER BY created_at DESC", (user_id,))]


def all_requests(status: str | None = None) -> list[dict]:
    ensure_schema()
    sql = """SELECT b.*, u.email AS user_email, u.name AS user_name FROM billing_requests b
             JOIN users u ON u.id = b.user_id"""
    params: list = []
    if status:
        sql += " WHERE b.status = ?"
        params.append(status)
    sql += " ORDER BY CASE b.status WHEN 'pending' THEN 0 ELSE 1 END, b.created_at DESC"
    return [_public_request(r) for r in db.all_rows(sql, params)]


def decide_request(request_id: str, approve: bool, searches: int | None, note: str) -> dict:
    ensure_schema()
    row = db.one("SELECT * FROM billing_requests WHERE id = ?", (request_id,))
    if not row:
        raise AccountError("Request not found.", 404)
    if row["status"] != "pending":
        raise AccountError("This request was already decided.", 409)
    stamp = now()
    note = (note or "").strip()[:500] or None
    if not approve:
        db.execute("UPDATE billing_requests SET status = 'rejected', admin_note = ?, decided_at = ? WHERE id = ?", (note, stamp, request_id))
    else:
        granted = row["searches_requested"] if searches is None else searches
        if granted < 1 or granted > 100_000:
            raise AccountError("Searches to give must be between 1 and 100000.")
        with db.transaction() as connection:
            connection.execute(
                "UPDATE billing_requests SET status = 'approved', searches_granted = ?, admin_note = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
                (granted, note, stamp, request_id),
            )
            connection.execute("UPDATE users SET searches_allowed = searches_allowed + ?, plan_id = ? WHERE id = ?", (granted, row["plan_id"], row["user_id"]))
            connection.execute(
                "INSERT INTO search_log (id, user_id, product_id, change, reason, created_at) VALUES (?, ?, NULL, ?, ?, ?)",
                (str(uuid.uuid4()), row["user_id"], granted, f"{row['plan_name']} plan approved", stamp),
            )
    return _public_request(db.one("SELECT b.*, u.email AS user_email, u.name AS user_name FROM billing_requests b JOIN users u ON u.id = b.user_id WHERE b.id = ?", (request_id,)))


# ---------- Admin: users ----------

def list_users() -> list[dict]:
    ensure_schema()
    rows = db.all_rows(
        """SELECT u.*, (SELECT COUNT(*) FROM products p WHERE p.owner_id = u.id) AS products
           FROM users u ORDER BY u.created_at DESC"""
    )
    return [{**public_user(r), "products": r["products"]} for r in rows]


def admin_update_user(user_id: str, *, add_searches: int | None = None, set_allowed: int | None = None, status: str | None = None) -> dict:
    ensure_schema()
    user = db.one("SELECT * FROM users WHERE id = ?", (user_id,))
    if not user:
        raise AccountError("User not found.", 404)
    stamp = now()
    with db.transaction() as connection:
        if add_searches is not None:
            if add_searches == 0 or abs(add_searches) > 100_000:
                raise AccountError("Enter how many searches to add (or a minus number to take away).")
            new_allowed = max(int(user["searches_used"]), int(user["searches_allowed"]) + add_searches)
            connection.execute("UPDATE users SET searches_allowed = ? WHERE id = ?", (new_allowed, user_id))
            connection.execute(
                "INSERT INTO search_log (id, user_id, product_id, change, reason, created_at) VALUES (?, ?, NULL, ?, 'Changed by the admin', ?)",
                (str(uuid.uuid4()), user_id, new_allowed - int(user["searches_allowed"]), stamp),
            )
        if set_allowed is not None:
            if set_allowed < 0 or set_allowed > 1_000_000:
                raise AccountError("Total searches must be between 0 and 1000000.")
            new_allowed = max(int(user["searches_used"]), set_allowed)
            connection.execute("UPDATE users SET searches_allowed = ? WHERE id = ?", (new_allowed, user_id))
            connection.execute(
                "INSERT INTO search_log (id, user_id, product_id, change, reason, created_at) VALUES (?, ?, NULL, ?, 'Total set by the admin', ?)",
                (str(uuid.uuid4()), user_id, new_allowed - int(user["searches_allowed"]), stamp),
            )
        if status is not None:
            if status not in ("active", "blocked"):
                raise AccountError("Status must be active or blocked.")
            connection.execute("UPDATE users SET status = ? WHERE id = ?", (status, user_id))
    return public_user(db.one("SELECT * FROM users WHERE id = ?", (user_id,)))


def admin_totals() -> dict:
    ensure_schema()
    users = db.one(
        """SELECT COUNT(*) AS n,
                  SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
                  COALESCE(SUM(searches_used), 0) AS used,
                  COALESCE(SUM(CASE WHEN searches_allowed > searches_used THEN searches_allowed - searches_used ELSE 0 END), 0) AS left_total
           FROM users"""
    )
    pending = db.one("SELECT COUNT(*) AS n FROM billing_requests WHERE status = 'pending'")
    approved = db.one("SELECT COUNT(*) AS n FROM billing_requests WHERE status = 'approved'")
    return {
        "users": users["n"],
        "activeUsers": users["active"] or 0,
        "searchesUsed": users["used"],
        "searchesLeft": users["left_total"],
        "pendingRequests": pending["n"],
        "approvedRequests": approved["n"],
    }


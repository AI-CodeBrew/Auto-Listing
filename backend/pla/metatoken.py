"""The Meta Ad Library token, kept alive.

Meta only answers Ad Library searches for a person's token, and those last 60 days. A token that is
still valid can be swapped for a fresh 60-day one, so this does that well before it runs out and
keeps the newest one in the settings table. META_ACCESS_TOKEN in .env is only the starting token:
put a new one there and it takes over.
"""
from __future__ import annotations

import hashlib
import json
import threading
import time

import requests

from . import config, db

EXCHANGE_URL = "https://graph.facebook.com/v21.0/oauth/access_token"
KEY = "meta_token"
RENEW_WHEN_LEFT_S = 30 * 24 * 3600  # swap once fewer than 30 of the 60 days are left
CHECK_EVERY_S = 6 * 3600            # and look at most this often
ASSUMED_LIFE_S = 60 * 24 * 3600

_lock = threading.Lock()
_last_check = 0.0


def _seed(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()[:16]


def _saved() -> dict | None:
    """The renewed token, if it still descends from the one in .env."""
    row = db.one("SELECT value FROM settings WHERE key = ?", (KEY,))
    if not row:
        return None
    try:
        saved = json.loads(row["value"])
    except ValueError:
        return None
    if not isinstance(saved, dict) or not saved.get("token") or saved.get("seed") != _seed(config.meta_access_token()):
        return None
    return saved


def _save(token: str, expires: float) -> None:
    value = json.dumps({"token": token, "expires": expires, "seed": _seed(config.meta_access_token())})
    db.execute("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", (KEY, value))


def _exchange(token: str) -> tuple[str, float] | None:
    """A fresh 60-day token for one that still works, or None when Meta says no."""
    try:
        response = requests.get(EXCHANGE_URL, timeout=30, params={
            "grant_type": "fb_exchange_token", "client_id": config.meta_app_id(),
            "client_secret": config.meta_app_secret(), "fb_exchange_token": token,
        })
        body = response.json() if response.text else {}
    except (requests.RequestException, ValueError):
        print("[meta-token] could not reach Meta to renew the token")
        return None
    fresh = body.get("access_token")
    if not response.ok or not fresh:
        print(f"[meta-token] renewal refused ({(body.get('error') or {}).get('code') or response.status_code})")
        return None
    return fresh, time.time() + float(body.get("expires_in") or ASSUMED_LIFE_S)


def renew_if_due(force: bool = False) -> None:
    """Swaps the token for a fresh one when it is new to us or has under 30 days left. Never raises."""
    global _last_check
    start = config.meta_access_token()
    if not start or not config.meta_app_id() or not config.meta_app_secret():
        return
    with _lock:
        if not force and time.time() - _last_check < CHECK_EVERY_S:
            return
        _last_check = time.time()
        try:
            saved = _saved()
            if saved and float(saved.get("expires") or 0) - time.time() > RENEW_WHEN_LEFT_S:
                return
            renewed = _exchange(saved["token"] if saved else start)
            if renewed:
                _save(*renewed)
                print(f"[meta-token] renewed, good for {round((renewed[1] - time.time()) / 86400)} days")
        except Exception as error:  # noqa: BLE001
            print("[meta-token] renewal skipped:", type(error).__name__)


def current() -> str:
    """The token to search with: the renewed one when there is one, otherwise the one in .env."""
    renew_if_due()
    try:
        saved = _saved()
    except Exception:  # noqa: BLE001
        saved = None
    return saved["token"] if saved else config.meta_access_token()

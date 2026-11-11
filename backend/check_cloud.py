"""Checks that this backend reaches Supabase (DATABASE_URL) and Bunny (BUNNY_*) with the keys in
backend/.env. It creates any missing table, writes one small test file to Bunny, reads it back
through the CDN, and deletes it again. Nothing else changes.

Run from the backend folder:  .venv\\Scripts\\python check_cloud.py
"""
from __future__ import annotations

import os
import sys
import tempfile
import time
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pla.envfile import load_env_files  # noqa: E402

load_env_files()

import httpx  # noqa: E402

from pla import bunny, db  # noqa: E402


def check_database() -> bool:
    if not db.is_postgres():
        print("Supabase: DATABASE_URL is empty, so the records stay in the local SQLite file.")
        return False
    try:
        db.conn()
        tables = db.one("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = 'public'")["n"]
        users = db.one("SELECT COUNT(*) AS n FROM users")["n"]
        products = db.one("SELECT COUNT(*) AS n FROM products")["n"]
    except Exception as error:  # noqa: BLE001
        message = str(error).splitlines()[0]
        print(f"Supabase: FAILED. {message}")
        if "deadlock" in message or "lock timeout" in message:
            print("  Another backend is using the tables. Stop every running backend (Ctrl+C in its window), then run this again.")
        else:
            print("  Check DATABASE_URL in backend/.env (Supabase > Connect > Transaction pooler, with your database password).")
        return False
    print(f"Supabase: OK. {tables} tables, {users} users, {products} products.")
    return True


# Every Bunny Storage region. A zone answers only on the host of its main region.
REGION_HOSTS = [
    "storage.bunnycdn.com",  # Falkenstein, Germany (Bunny's default)
    "sg.storage.bunnycdn.com",
    "uk.storage.bunnycdn.com",
    "se.storage.bunnycdn.com",
    "ny.storage.bunnycdn.com",
    "la.storage.bunnycdn.com",
    "br.storage.bunnycdn.com",
    "jh.storage.bunnycdn.com",
    "syd.storage.bunnycdn.com",
]


def _host_that_answers() -> str | None:
    """Lists the zone on every region's host (reading only) and returns the one that accepts the login."""
    zone = os.environ.get("BUNNY_STORAGE_ZONE", "")
    key = os.environ.get("BUNNY_STORAGE_KEY", "")
    current = os.environ.get("BUNNY_STORAGE_HOST", "").replace("https://", "").rstrip("/")
    for host in REGION_HOSTS:
        if host == current:
            continue
        try:
            response = httpx.get(f"https://{host}/{zone}/", headers={"AccessKey": key, "Accept": "application/json"}, timeout=15)
        except httpx.HTTPError:
            continue
        if response.status_code == 200:
            return host
    return None


def _bunny_hint(error: bunny.BunnyError) -> str:
    """Tells a read-only password apart from a wrong region host, password or zone."""
    if error.status != 401:
        return "  Check BUNNY_STORAGE_HOST (the Hostname on the zone's FTP & API Access page) and your internet connection."
    try:
        bunny.list_files("")
    except bunny.BunnyError:
        print("  Trying the other Bunny regions (reading only)...")
        host = _host_that_answers()
        if host:
            return f"  Your zone is in another region. In backend/.env set:\n  BUNNY_STORAGE_HOST={host}"
        return (
            "  No region accepted this zone name and password. On the zone's FTP & API Access page check that\n"
            "  BUNNY_STORAGE_ZONE = Username and BUNNY_STORAGE_KEY = Password. If you reset the password,\n"
            "  copy the new one into backend/.env."
        )
    return (
        "  Reading works but writing does not: BUNNY_STORAGE_KEY is the Read-only password.\n"
        "  Use the Password (not Read-only password) from the zone's FTP & API Access page."
    )


def check_bunny() -> bool:
    if not bunny.enabled():
        print("Bunny: not set up. Fill in BUNNY_STORAGE_ZONE, BUNNY_STORAGE_KEY, BUNNY_STORAGE_HOST and BUNNY_CDN_URL.")
        return False
    path = f"check/{uuid.uuid4().hex}.txt"
    text = b"FynkTech Bunny check"
    with tempfile.TemporaryDirectory() as folder:
        local = os.path.join(folder, "check.txt")
        with open(local, "wb") as handle:
            handle.write(text)
        try:
            bunny.upload(local, path)
            print("Bunny storage: upload OK.")
        except bunny.BunnyError as error:
            print(f"Bunny storage: FAILED. {error}")
            print(_bunny_hint(error))
            return False
    try:
        url = bunny.public_url(path)
        body = b""
        for _ in range(5):
            response = httpx.get(url, timeout=20)
            body = response.content if response.status_code == 200 else b""
            if body == text:
                break
            time.sleep(2)
        if body == text:
            print(f"Bunny CDN: OK ({url}).")
        else:
            print(f"Bunny CDN: FAILED. {url} did not return the test file.")
            print("  Check BUNNY_CDN_URL, and that the pull zone's origin is this storage zone.")
            return False
    finally:
        bunny.delete(path)
    return True


if __name__ == "__main__":
    ok_db = check_database()
    ok_bunny = check_bunny()
    print("All set." if ok_db and ok_bunny else "Fix the lines marked FAILED, then run this again.")

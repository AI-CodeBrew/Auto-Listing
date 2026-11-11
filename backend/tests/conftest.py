"""Unit tests for the backend. The Shopify and theme tests talk to the mock server the Playwright
suite starts (frontend/tests/mock/server.ts), at MOCK_URL. Only mock keys are used."""
from __future__ import annotations

import os
import sys
import tempfile

import pytest
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)
sys.path.insert(0, BACKEND)

# Each run gets its own database, so the tests never touch the real ./data folder.
_tmp = tempfile.mkdtemp(prefix="pla-unit-")
os.environ["APP_DATA_DIR"] = os.path.join(_tmp, "data")
os.environ["APP_STORAGE_DIR"] = os.path.join(_tmp, "storage")
os.environ.setdefault("APP_ROOT", os.path.dirname(BACKEND))
os.environ.pop("ALLOW_PRIVATE_NETWORK", None)
# Real Bunny keys never reach the tests; the Bunny tests start their own mock server.
for _name in ("BUNNY_STORAGE_KEY", "BUNNY_STORAGE_ZONE", "BUNNY_STORAGE_HOST", "BUNNY_CDN_URL"):
    os.environ.pop(_name, None)

# SQLite by default. PLA_TEST_DATABASE_URL runs the same tests on Postgres, but only on a database
# on this computer, because every table in it is dropped first.
os.environ["DATABASE_URL"] = os.environ.get("PLA_TEST_DATABASE_URL", "")
if os.environ["DATABASE_URL"]:
    from urllib.parse import urlparse

    import psycopg

    if (urlparse(os.environ["DATABASE_URL"]).hostname or "") not in ("localhost", "127.0.0.1", "::1"):
        raise SystemExit("PLA_TEST_DATABASE_URL must point at a database on this computer (localhost); it is wiped.")
    with psycopg.connect(os.environ["DATABASE_URL"], autocommit=True) as _pg:
        _pg.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")

MOCK_URL = os.environ.get("MOCK_URL", "http://127.0.0.1:4100")


def mock_up() -> bool:
    try:
        requests.get(f"{MOCK_URL}/__state", timeout=2)
        return True
    except requests.RequestException:
        return False


@pytest.fixture
def mock():
    if not mock_up():
        pytest.skip("The mock server is not running. Run these through the Playwright suite: cd frontend; npm test")

    class Mock:
        url = MOCK_URL

        @staticmethod
        def reset():
            requests.post(f"{MOCK_URL}/__reset", timeout=5)

        @staticmethod
        def set(values: dict):
            requests.post(f"{MOCK_URL}/__set", json=values, timeout=5)

        @staticmethod
        def state() -> dict:
            return requests.get(f"{MOCK_URL}/__state", timeout=5).json()

    Mock.reset()
    return Mock


@pytest.fixture
def shopify_env(mock, monkeypatch):
    from pla import settings
    from pla.shopify.client import clear_token_cache

    clear_token_cache()
    settings.current_owner.set(None)
    settings.clear_shopify_credentials()
    for key, value in {
        "SHOPIFY_STORE_DOMAIN": "mock-store.myshopify.com",
        "SHOPIFY_CLIENT_ID": "mock-client",
        "SHOPIFY_CLIENT_SECRET": "mock-secret",
        "SHOPIFY_ADMIN_TOKEN": "",
        "SHOPIFY_BASE_URL_OVERRIDE": MOCK_URL,
    }.items():
        monkeypatch.setenv(key, value)
    return mock

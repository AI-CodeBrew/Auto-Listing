"""Walks the main API routes on whichever database the tests use: SQLite, or Postgres when
PLA_TEST_DATABASE_URL is set. Nothing leaves this computer: the research queue never starts
(the app's startup only runs inside "with TestClient(...)"), and every AI and search key is empty."""
from __future__ import annotations

import io
import uuid

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from pla import accounts, repo
from pla.api import create_app


@pytest.fixture
def app(monkeypatch):
    monkeypatch.setenv("ADMIN_EMAIL", "admin@test.local")
    monkeypatch.setenv("ADMIN_PASSWORD", "test-admin-password")
    for key in ("OPENAI_API_KEY", "AI_API_KEY", "SERPAPI_API_KEY", "SERPAPI_API_KEY_2", "SHOPIFY_ADMIN_TOKEN", "SHOPIFY_STORE_DOMAIN"):
        monkeypatch.setenv(key, "")
    return create_app()


def client(app) -> TestClient:
    # The backend only accepts changes from its own pages, which reach it as localhost.
    return TestClient(app, base_url="http://localhost")


def photo() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (640, 640), (40, 120, 110)).save(buffer, "JPEG")
    return buffer.getvalue()


def new_product(user: TestClient, name: str):
    return user.post("/api/products", data={"name": name}, files={"images": ("bottle.jpg", photo(), "image/jpeg")})


def test_user_and_admin_flow(app):
    user = client(app)
    email = f"smoke-{uuid.uuid4().hex[:8]}@test.local"
    assert user.post("/api/auth/signup", json={"name": "Smoke", "email": email, "password": "password123"}).status_code == 201
    me = user.get("/api/auth/me").json()
    assert me["role"] == "user" and me["user"]["searchesLeft"] == 2

    # Two free searches: two products start, the third is refused.
    first = new_product(user, "Smoke Bottle")
    assert first.status_code == 201, first.text
    product_id = first.json()["product"]["id"]
    second = new_product(user, "Smoke Jar")
    assert second.status_code == 201, second.text
    third = new_product(user, "Smoke Cup")
    assert third.status_code in (402, 403), third.text

    status = user.get("/api/status").json()
    assert status["counts"]["researching"] == 2
    listed = user.get("/api/products", params={"stages": "researching"}).json()
    assert {p["id"] for p in listed["products"]} >= {product_id}
    assert user.get("/api/jobs").status_code == 200

    # Research done (the queue is off here): approve one, reject the other.
    for created in (first.json(), second.json()):
        repo.finish_job(created["job"]["id"], "DONE", "Ready for review", None)
        repo.update_product(created["product"]["id"], {"stage": "review", "description": "A steel bottle.\n- Steel body: Strong"})
    approved = user.post(f"/api/products/{product_id}/approve", json={"name": "Smoke Bottle", "imageIds": [], "videoIds": []})
    assert approved.status_code == 200, approved.text
    sku = approved.json()["product"]["sku"]
    assert sku  # the SKU counter (an upsert) worked
    patched = user.patch(f"/api/products/{product_id}", json={"name": "Smoke Bottle 2", "sku": sku, "price": "1999", "cost": "900"})
    assert patched.status_code == 200, patched.text
    assert patched.json()["product"]["price"] == "1999"
    assert user.post(f"/api/products/{second.json()['product']['id']}/reject").status_code == 200
    detail = user.get(f"/api/products/{product_id}").json()
    assert detail["product"]["stage"] == "listing" and detail["images"] == [] and detail["job"]["status"] == "DONE"
    counts = user.get("/api/products", params={"stages": "listing,rejected"}).json()["counts"]
    assert counts["listing"] == 1 and counts["rejected"] == 1

    # A refund puts a search back (the CASE that replaced SQLite's two-argument MAX).
    user_id = me["user"]["id"]
    accounts.refund_search(user_id, product_id)
    assert user.get("/api/auth/me").json()["user"]["searchesLeft"] == 1

    # Billing: the user asks for a plan, the admin approves it with 5 searches.
    plans = user.get("/api/billing").json()
    assert len(plans["plans"]) == 3
    asked = user.post("/api/billing/request", json={"planId": plans["plans"][0]["id"], "paymentNote": "JazzCash 123"})
    assert asked.status_code == 201, asked.text

    admin = client(app)
    assert admin.post("/api/admin/login", json={"email": "admin@test.local", "password": "test-admin-password"}).status_code == 200
    overview = admin.get("/api/admin/overview")
    assert overview.status_code == 200, overview.text
    assert overview.json()["accounts"]["users"] >= 1
    assert any(u["id"] == user_id for u in admin.get("/api/admin/users").json()["users"])
    assert admin.get(f"/api/admin/users/{user_id}").status_code == 200
    pending = admin.get("/api/admin/billing", params={"status": "pending"}).json()["requests"]
    request_id = next(r["id"] for r in pending if r["userId"] == user_id)
    decided = admin.post(f"/api/admin/billing/{request_id}", json={"approve": True, "searches": 5, "note": "ok"})
    assert decided.status_code == 200, decided.text
    assert user.get("/api/auth/me").json()["user"]["searchesLeft"] == 6
    added = admin.patch(f"/api/admin/users/{user_id}", json={"addSearches": 2})
    assert added.status_code == 200, added.text
    assert user.get("/api/auth/me").json()["user"]["searchesLeft"] == 8
    plan = admin.get("/api/admin/plans").json()["plans"][0]
    changed = admin.put(f"/api/admin/plans/{plan['id']}", json={**plan, "name": "Starter Plus"})
    assert changed.status_code == 200, changed.text
    assert admin.get("/api/admin/plans").json()["plans"][0]["name"] == "Starter Plus"
    assert admin.get("/api/status").status_code == 200

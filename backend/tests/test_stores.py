"""Shopify stores: every plan has a store limit, a user can connect that many, and one is active at a time."""
from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from pla import accounts, db, settings
from pla.api import create_app


@pytest.fixture(autouse=True)
def fresh():
    db.conn()
    accounts.ensure_schema()
    for table in ("search_log", "billing_requests", "shopify_stores", "users"):
        db.execute(f"DELETE FROM {table}")
    yield
    settings.current_owner.set(None)
    settings.current_store.set(None)


def make_user(name="Store User") -> str:
    user = accounts.sign_up(name, f"{uuid.uuid4().hex[:8]}@test.local", "password123")
    settings.current_owner.set(user["id"])
    return user["id"]


def add(owner: str, domain: str, **extra):
    return settings.add_store(owner, method="client", domain=domain, client_id="id", client_secret="secret", **extra)


def test_plans_carry_a_store_limit_the_admin_can_change():
    plans = {p["id"]: p for p in accounts.list_plans(include_inactive=True)}
    assert (plans["starter"]["stores"], plans["pro"]["stores"], plans["business"]["stores"]) == (1, 3, 10)
    changed = accounts.update_plan("pro", {"stores": 5})
    assert changed["stores"] == 5
    for bad in (0, 1001, "many"):
        with pytest.raises(accounts.AccountError):
            accounts.update_plan("pro", {"stores": bad})
    accounts.update_plan("pro", {"stores": 3})


def test_the_allowance_follows_the_plan():
    owner = make_user()
    assert accounts.store_allowance(owner) == {"limit": 1, "planName": None}
    request = accounts.request_plan(owner, "pro", "paid")
    accounts.decide_request(request["id"], True, None, "")
    assert accounts.store_allowance(owner) == {"limit": 3, "planName": "Pro"}


def test_stores_are_listed_activated_and_removed():
    owner = make_user()
    first = add(owner, "https://First-Shop.myshopify.com/")
    second = add(owner, "second-shop")
    assert [s["domain"] for s in settings.list_stores(owner)] == ["first-shop.myshopify.com", "second-shop.myshopify.com"]
    # The first store is active until another is chosen, and it drives every Shopify call.
    assert settings.shopify_credentials()["domain"] == "first-shop.myshopify.com"
    settings.activate_store(owner, second["id"])
    assert settings.shopify_credentials()["domain"] == "second-shop.myshopify.com"
    with pytest.raises(settings.StoreError, match="already connected"):
        add(owner, "second-shop.myshopify.com")
    # A blank secret keeps the saved one.
    settings.update_store(owner, second["id"], method="client", domain="second-shop.myshopify.com", client_id="new-id", client_secret="")
    assert settings.shopify_credentials()["clientSecret"] == "secret" and settings.shopify_credentials()["clientId"] == "new-id"
    settings.remove_store(owner, second["id"])
    assert settings.shopify_credentials()["domain"] == first["domain"]
    with pytest.raises(settings.StoreError):
        settings.activate_store(owner, second["id"])


def test_a_user_never_sees_another_users_store():
    one, two = make_user("One"), make_user("Two")
    settings.add_store(one, method="client", domain="one-shop", client_id="a", client_secret="b")
    assert settings.list_stores(two) == []
    settings.current_owner.set(two)
    assert settings.shopify_credentials()["domain"] == ""


def test_a_store_connected_before_the_list_existed_becomes_the_first_one():
    owner = make_user()
    for key, value in {"shopify_method": "client", "shopify_domain": "old-shop.myshopify.com", "shopify_client_id": "old-id", "shopify_client_secret": "old-secret"}.items():
        settings.write_setting(f"u:{owner}:{key}", value)
    rows = settings.list_stores(owner)
    assert [(r["domain"], r["client_id"], r["client_secret"]) for r in rows] == [("old-shop.myshopify.com", "old-id", "old-secret")]
    assert settings.read_setting(f"u:{owner}:shopify_domain") == ""
    assert settings.shopify_credentials()["domain"] == "old-shop.myshopify.com"


def test_a_running_push_keeps_its_store_when_the_active_one_changes():
    owner = make_user()
    first = add(owner, "first-shop")
    second = add(owner, "second-shop")
    settings.activate_store(owner, first["id"])
    settings.pin_active_store()
    settings.activate_store(owner, second["id"])
    assert settings.shopify_credentials()["domain"] == "first-shop.myshopify.com"
    settings.current_store.set(None)
    assert settings.shopify_credentials()["domain"] == "second-shop.myshopify.com"


def test_the_last_theme_push_is_remembered_per_store():
    owner = make_user()
    first = add(owner, "first-shop")
    second = add(owner, "second-shop")
    settings.activate_store(owner, first["id"])
    settings.save_template_push("classic", {"domain": "first-shop.myshopify.com", "at": "x"})
    settings.activate_store(owner, second["id"])
    assert settings.last_template_push("classic") is None
    settings.activate_store(owner, first["id"])
    assert settings.last_template_push("classic")["domain"] == "first-shop.myshopify.com"


def test_the_api_stops_at_the_plan_limit_and_the_admin_can_raise_it(monkeypatch):
    monkeypatch.setenv("ADMIN_EMAIL", "admin@test.local")
    monkeypatch.setenv("ADMIN_PASSWORD", "test-admin-password")
    client = TestClient(create_app(), base_url="http://localhost")
    email = f"{uuid.uuid4().hex[:8]}@test.local"
    assert client.post("/api/auth/signup", json={"name": "Limit", "email": email, "password": "password123"}).status_code == 201
    user_id = client.get("/api/auth/me").json()["user"]["id"]

    form = {"method": "client", "clientId": "id", "clientSecret": "secret"}
    first = client.post("/api/stores", json={**form, "domain": "one"})
    assert first.status_code == 201 and first.json()["limit"] == 1 and first.json()["canAdd"] is False
    refused = client.post("/api/stores", json={**form, "domain": "two"})
    assert refused.status_code == 403 and "allows 1 store" in refused.json()["error"]

    # A bigger plan gives more room.
    request = accounts.request_plan(user_id, "pro", "paid")
    accounts.decide_request(request["id"], True, None, "")
    for name in ("two", "three"):
        assert client.post("/api/stores", json={**form, "domain": name}).status_code == 201
    listed = client.get("/api/stores").json()
    assert listed["used"] == 3 and listed["limit"] == 3 and listed["planName"] == "Pro" and listed["canAdd"] is False
    assert client.post("/api/stores", json={**form, "domain": "four"}).status_code == 403
    # The last one added is the active one, and the single-store routes follow it.
    assert [s["domain"] for s in listed["stores"] if s["active"]] == ["three.myshopify.com"]
    assert client.get("/api/settings/shopify").json()["domain"] == "three.myshopify.com"
    first_id = listed["stores"][0]["id"]
    switched = client.post(f"/api/stores/{first_id}/activate").json()
    assert [s["domain"] for s in switched["stores"] if s["active"]] == ["one.myshopify.com"]
    assert client.get("/api/settings/shopify").json()["domain"] == "one.myshopify.com"
    # Secrets are never sent back.
    assert "secret" not in client.get("/api/stores").text.replace("hasSecret", "")
    removed = client.delete(f"/api/stores/{first_id}").json()
    assert removed["used"] == 2 and removed["canAdd"] is True
    # Another user's store id is not found.
    other = TestClient(create_app(), base_url="http://localhost")
    other.post("/api/auth/signup", json={"name": "Other", "email": f"{uuid.uuid4().hex[:8]}@test.local", "password": "password123"})
    assert other.post(f"/api/stores/{listed['stores'][1]['id']}/activate").status_code == 404


def test_each_store_picks_the_page_its_new_products_get():
    from pla.shopify.send import build_product_input

    owner = make_user()
    first = add(owner, "first-shop")
    second = add(owner, "second-shop")
    product = {"name": "Mug", "price": "10", "description": "A mug.", "sku": "SKU-1", "shopify_product_id": "gid://shopify/Product/1", "shopify_handle": "mug"}

    def suffix(update=False):
        return build_product_input(product=product, image_sources=[], file_video_sources=[], external_videos=[], update=update).get("templateSuffix")

    # Until a page is chosen, new products get the Bundle page, as before.
    settings.activate_store(owner, first["id"])
    assert settings.default_template_id() == "saamano" and suffix() == "fynk-autolisting-product"
    # The choice belongs to the store: the first store moves on to the Classic page, the second does not.
    settings.save_default_template("classic")
    assert suffix() == "fynk-classic-product"
    settings.activate_store(owner, second["id"])
    assert suffix() == "fynk-autolisting-product"
    settings.activate_store(owner, first["id"])
    assert suffix() == "fynk-classic-product"
    # Updating a product that is already on the store never changes its page.
    assert suffix(update=True) is None
    # A page that no longer exists falls back to the Bundle page.
    settings.save_default_template("gone")
    assert suffix() == "fynk-autolisting-product"


def test_a_page_not_in_the_store_cannot_be_chosen_for_new_products(monkeypatch):
    monkeypatch.setenv("ADMIN_EMAIL", "admin@test.local")
    monkeypatch.setenv("ADMIN_PASSWORD", "test-admin-password")
    client = TestClient(create_app(), base_url="http://localhost")
    email = f"{uuid.uuid4().hex[:8]}@test.local"
    assert client.post("/api/auth/signup", json={"name": "Pick", "email": email, "password": "password123"}).status_code == 201
    client.post("/api/stores", json={"method": "client", "domain": "pick-shop", "clientId": "id", "clientSecret": "secret"})
    refused = client.post("/api/templates/classic/use", json={})
    assert refused.status_code == 409 and "Add this page to your store first" in refused.json()["error"]
    assert client.post("/api/templates/nope/use", json={}).status_code == 404
    listed = client.get("/api/templates").json()["templates"]
    assert [(t["id"], t["useForNew"]) for t in listed] == [("saamano", True), ("classic", False)]
    # Once the page was added to this store it can be chosen, and the choice shows in the list.
    settings.current_owner.set(client.get("/api/auth/me").json()["user"]["id"])
    settings.save_template_push("classic", {"domain": "pick-shop.myshopify.com", "at": "x"})
    assert client.post("/api/templates/classic/use", json={}).status_code == 200
    listed = client.get("/api/templates").json()["templates"]
    assert [(t["id"], t["useForNew"]) for t in listed] == [("saamano", False), ("classic", True)]

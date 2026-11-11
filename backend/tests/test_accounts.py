"""Accounts: sign-up gives 2 free searches, a search is taken atomically, the admin approves plans."""
from __future__ import annotations

import pytest

from pla import accounts, db


@pytest.fixture(autouse=True)
def fresh_accounts():
    db.conn()
    accounts.ensure_schema()
    for table in ("search_log", "billing_requests", "users"):
        db.execute(f"DELETE FROM {table}")
    yield


def test_signup_gives_two_free_searches():
    user = accounts.sign_up("Ali", "Ali@Example.com", "password123")
    assert user["email"] == "ali@example.com"
    assert user["searchesAllowed"] == 2 and user["searchesLeft"] == 2
    with pytest.raises(accounts.AccountError, match="already exists"):
        accounts.sign_up("Ali 2", "ali@example.com", "password123")


def test_signup_checks_input():
    with pytest.raises(accounts.AccountError, match="valid email"):
        accounts.sign_up("A", "not-an-email", "password123")
    with pytest.raises(accounts.AccountError, match="8 characters"):
        accounts.sign_up("A", "a@b.co", "short")


def test_login_and_wrong_password():
    accounts.sign_up("Sara", "sara@example.com", "password123")
    assert accounts.log_in("SARA@example.com", "password123")["name"] == "Sara"
    with pytest.raises(accounts.AccountError) as caught:
        accounts.log_in("sara@example.com", "wrong-password")
    assert caught.value.status == 401


def test_searches_run_out_after_two():
    user = accounts.sign_up("Free", "free@example.com", "password123")
    accounts.consume_search(user["id"], "p1")
    accounts.consume_search(user["id"], "p2")
    with pytest.raises(accounts.AccountError) as caught:
        accounts.consume_search(user["id"], "p3")
    assert caught.value.status == 402
    assert accounts.user_overview(user["id"])["user"]["searchesLeft"] == 0


def test_refund_gives_the_search_back():
    user = accounts.sign_up("R", "r@example.com", "password123")
    accounts.consume_search(user["id"], "p1")
    accounts.refund_search(user["id"], "p1")
    assert accounts.user_overview(user["id"])["user"]["searchesLeft"] == 2


def test_plan_request_and_admin_approval():
    user = accounts.sign_up("Buyer", "buyer@example.com", "password123")
    plans = accounts.list_plans()
    assert [p["id"] for p in plans] == ["starter", "pro", "business"]
    request = accounts.request_plan(user["id"], "pro", "JazzCash 123")
    assert request["status"] == "pending"
    with pytest.raises(accounts.AccountError, match="already have a request"):
        accounts.request_plan(user["id"], "starter", "")
    # The admin decides how many searches to give, which may differ from the plan.
    decided = accounts.decide_request(request["id"], True, 60, "Paid, thanks")
    assert decided["status"] == "approved" and decided["searchesGranted"] == 60
    overview = accounts.user_overview(user["id"])["user"]
    assert overview["searchesLeft"] == 62 and overview["planId"] == "pro"
    with pytest.raises(accounts.AccountError, match="already decided"):
        accounts.decide_request(request["id"], False, None, "")


def test_rejected_request_gives_nothing():
    user = accounts.sign_up("No", "no@example.com", "password123")
    request = accounts.request_plan(user["id"], "starter", "")
    accounts.decide_request(request["id"], False, None, "No payment found")
    assert accounts.user_overview(user["id"])["user"]["searchesLeft"] == 2


def test_admin_changes_and_blocks_users():
    user = accounts.sign_up("U", "u@example.com", "password123")
    assert accounts.admin_update_user(user["id"], add_searches=5)["searchesLeft"] == 7
    assert accounts.admin_update_user(user["id"], status="blocked")["status"] == "blocked"
    token = accounts.make_token(user["id"], "user")
    assert accounts.session_user(token) is None
    with pytest.raises(accounts.AccountError) as caught:
        accounts.log_in("u@example.com", "password123")
    assert caught.value.status == 403


def test_tokens_are_signed(monkeypatch):
    user = accounts.sign_up("T", "t@example.com", "password123")
    token = accounts.make_token(user["id"], "user")
    assert accounts.session_user(token)["id"] == user["id"]
    payload, signature = token.rsplit(".", 1)
    assert accounts.session_user(payload + "." + signature[::-1]) is None
    # An admin token only works while the admin login is configured.
    monkeypatch.setenv("ADMIN_EMAIL", "boss@example.com")
    monkeypatch.setenv("ADMIN_PASSWORD", "secret-pass")
    assert accounts.session_user(accounts.make_token("admin", "admin"))["role"] == "admin"
    monkeypatch.setenv("ADMIN_PASSWORD", "")
    assert accounts.session_user(accounts.make_token("admin", "admin")) is None

"""Shopify Admin GraphQL client. Uses a pasted Admin API token, or gets one from the client ID
and secret (client credentials grant)."""
from __future__ import annotations

import json
import threading
import time

import requests

from .. import config
from ..settings import shopify_credentials


class ShopifyError(Exception):
    pass


REFRESH_MARGIN_S = 5 * 60
MAX_THROTTLE_RETRIES = 4
_tokens: dict[str, tuple[str, float]] = {}
_token_lock = threading.Lock()


def missing_shopify_settings() -> list[str]:
    creds = shopify_credentials()
    missing = []
    if not creds["domain"]:
        missing.append("Store domain")
    if creds["method"] == "token":
        if not creds["adminToken"]:
            missing.append("Admin API access token")
        return missing
    if not creds["clientId"]:
        missing.append("Client ID")
    if not creds["clientSecret"]:
        missing.append("Client secret")
    return missing


def shopify_base_url(domain: str | None = None) -> str:
    return config.shopify_base_url_override() or f"https://{domain if domain is not None else shopify_credentials()['domain']}"


def clear_token_cache() -> None:
    with _token_lock:
        _tokens.clear()


def _get_token(force_new: bool = False) -> str:
    creds = shopify_credentials()
    if creds["method"] == "token":
        return creds["adminToken"]
    key = f"{creds['domain']}|{creds['clientId']}|{creds['clientSecret']}"
    with _token_lock:
        cached = _tokens.get(key)
    if not force_new and cached and time.time() < cached[1]:
        return cached[0]
    try:
        response = requests.post(
            f"{shopify_base_url(creds['domain'])}/admin/oauth/access_token",
            headers={"accept": "application/json"},
            data={"grant_type": "client_credentials", "client_id": creds["clientId"], "client_secret": creds["clientSecret"]},
            timeout=30,
        )
    except requests.RequestException as error:
        raise ShopifyError(f"Could not reach Shopify to get an access token: {error}") from error
    body = response.text
    if not response.ok:
        if "shop_not_permitted" in body:
            raise ShopifyError("Shopify refused the token: the app and the store must belong to the same organization, and the app must be installed on the store.")
        raise ShopifyError(f"Shopify refused the access token request (HTTP {response.status_code}). Check the store domain, client ID and client secret on the Shopify page. {body[:200]}")
    data = json.loads(body)
    lifetime = (data.get("expires_in") or 86_399)
    with _token_lock:
        _tokens[key] = (data["access_token"], time.time() + max(0, lifetime - REFRESH_MARGIN_S))
    return data["access_token"]


def graphql(query: str, variables: dict, timeout_ms: int = 120_000) -> dict:
    """Retries only when Shopify says the request did not run (THROTTLED or 401)."""
    force_new = False
    attempt = 0
    while True:
        token = _get_token(force_new)
        force_new = False
        try:
            response = requests.post(
                f"{shopify_base_url()}/admin/api/{config.shopify_api_version()}/graphql.json",
                headers={"content-type": "application/json", "x-shopify-access-token": token},
                data=json.dumps({"query": query, "variables": variables}),
                timeout=timeout_ms / 1000,
            )
        except requests.RequestException as error:
            raise ShopifyError(f"Could not reach Shopify: {error}") from error

        if response.status_code == 401 and shopify_credentials()["method"] == "token":
            raise ShopifyError("Shopify rejected the Admin API access token (HTTP 401). Check the store domain and the Admin token on the Integrations page. The token starts with shpat_.")
        if response.status_code == 401 and attempt == 0:
            force_new = True
            attempt += 1
            continue
        if response.status_code == 429 and attempt < MAX_THROTTLE_RETRIES:
            try:
                wait = float(response.headers.get("retry-after") or 0) * 1000
            except ValueError:
                wait = 0
            time.sleep((wait or 2000 * (attempt + 1)) / 1000)
            attempt += 1
            continue
        text = response.text
        if not response.ok:
            if response.status_code == 403:
                raise ShopifyError(f"Shopify denied access (HTTP 403). Check the app has the write_products and write_inventory scopes and is installed on this store. {text[:200]}")
            raise ShopifyError(f"Shopify returned HTTP {response.status_code}: {text[:300]}")
        parsed = json.loads(text)
        errors = parsed.get("errors")
        if errors:
            if isinstance(errors, str):
                errors = [{"message": errors}]
            throttled = any((e.get("extensions") or {}).get("code") == "THROTTLED" for e in errors)
            if throttled and attempt < MAX_THROTTLE_RETRIES:
                time.sleep(2 * (attempt + 1))
                attempt += 1
                continue
            raise ShopifyError("Shopify GraphQL error: " + "; ".join(e.get("message", "") for e in errors))
        if not parsed.get("data"):
            raise ShopifyError("Shopify returned an empty response.")
        return parsed["data"]


def test_shopify_connection() -> dict:
    missing = missing_shopify_settings()
    if missing:
        raise ShopifyError(f"Fill in: {', '.join(missing)}.")
    clear_token_cache()
    data = graphql("query ConnectionTest { shop { name } currentAppInstallation { accessScopes { handle } } }", {}, 30_000)
    granted = {scope["handle"] for scope in data["currentAppInstallation"]["accessScopes"]}
    missing_scopes = [scope for scope in ("write_products", "write_inventory") if scope not in granted]
    return {"shopName": data["shop"]["name"], "domain": shopify_credentials()["domain"], "missingScopes": missing_scopes}

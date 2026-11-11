"""Google Images and Google Lens through SerpAPI. Two keys from .env; the keys never leave the server."""
from __future__ import annotations

import re
import threading
import time

import requests

from .. import config
from ..repo import note_running_usage
from ..settings import save_serp_preference, serp_preference

_plan_cache: dict[str, tuple[float, dict | None]] = {}
_sticky: dict = {"key": None, "until": 0.0}
_lock = threading.Lock()


def clear_serp_key_sticky() -> None:
    _sticky["key"] = None
    _sticky["until"] = 0.0


def _fetch_plan(key: str) -> dict | None:
    with _lock:
        cached = _plan_cache.get(key)
    if cached and time.time() - cached[0] < 60:
        return cached[1]
    try:
        response = requests.get(f"{config.serp_api_base_url()}/account.json", params={"api_key": key}, timeout=15)
        try:
            body = response.json()
        except ValueError:
            body = None
        if not response.ok or not isinstance(body, dict) or isinstance(body.get("error"), str):
            with _lock:
                _plan_cache[key] = (time.time(), cached[1] if cached else None)
            return cached[1] if cached else None

        def num(value) -> float:
            try:
                return float(value) if value is not None else 0
            except (TypeError, ValueError):
                return 0

        plan_name = str(body.get("plan_name") or "Free Plan")
        left = body.get("total_searches_left") if body.get("total_searches_left") is not None else body.get("plan_searches_left")
        plan = {
            "planName": plan_name,
            "free": num(body.get("plan_monthly_price")) == 0 or bool(re.search("free", plan_name, re.I)),
            "searchesPerMonth": int(num(body.get("searches_per_month"))),
            "searchesLeft": int(num(left)),
            "thisMonthUsage": int(num(body.get("this_month_usage"))),
            "thisHourSearches": int(num(body.get("this_hour_searches"))),
            "hourlyLimit": int(num(body.get("account_rate_limit_per_hour"))),
        }
        with _lock:
            _plan_cache[key] = (time.time(), plan)
        return plan
    except requests.RequestException:
        return cached[1] if cached else None


def _apply_auto_switch(plans: list[dict | None]) -> dict:
    pref = serp_preference()
    keys = config.serp_api_keys()
    if not pref["auto"]:
        return pref
    other = 2 if pref["active"] == 1 else 1
    current = plans[pref["active"] - 1]
    backup = plans[other - 1]
    if not keys[pref["active"] - 1] or not current or current["searchesLeft"] > 0:
        return pref
    if not keys[other - 1] or not backup or backup["searchesLeft"] <= 0:
        return pref
    return save_serp_preference(active=other, auto=True)


def resolve_serp_key() -> str:
    if _sticky["key"] and time.time() < _sticky["until"]:
        return _sticky["key"]
    keys = config.serp_api_keys()
    plans = [_fetch_plan(k) if k else None for k in keys]
    pref = _apply_auto_switch(plans)
    key = keys[pref["active"] - 1] or keys[1 if pref["active"] == 1 else 0] or ""
    if key:
        _sticky["key"] = key
        _sticky["until"] = time.time() + 30
    return key


def serp_overview() -> dict:
    resolve_serp_key()
    pref = serp_preference()
    keys = config.serp_api_keys()
    plans = [_fetch_plan(k) if k else None for k in keys]
    return {
        "active": pref["active"],
        "auto": pref["auto"],
        "keys": [
            {"id": i, "configured": bool(keys[i - 1]), "active": pref["active"] == i and bool(keys[i - 1]), "plan": plans[i - 1]}
            for i in (1, 2)
        ],
    }


def serp_plan() -> dict | None:
    key = resolve_serp_key()
    return _fetch_plan(key) if key else None


class SerpExhausted(Exception):
    pass


def _get_once(key: str, params: dict) -> dict:
    try:
        response = requests.get(f"{config.serp_api_base_url()}/search.json", params={**params, "api_key": key}, timeout=60)
    except requests.RequestException as error:
        raise RuntimeError(f"Could not reach SerpAPI. Check your internet connection. {error}".strip()) from error
    text = response.text
    try:
        body = response.json()
        if not isinstance(body, dict):
            body = {}
    except ValueError:
        body = {}
    error = body.get("error") or ""
    if response.status_code == 401 or re.search(r"invalid api key", error, re.I):
        raise RuntimeError("SerpAPI rejected the active key. Check SERPAPI_API_KEY and SERPAPI_API_KEY_2 in .env, then restart the app.")
    if response.status_code == 429 or re.search(r"run out of searches|plan", error, re.I):
        raise SerpExhausted(f"SerpAPI has no searches left on your plan: {error or 'rate limit reached'}")
    if error and not re.search(r"hasn't returned any results", error, re.I):
        raise RuntimeError(f"SerpAPI error: {error}")
    if not response.ok and not error:
        raise RuntimeError(f"SerpAPI returned HTTP {response.status_code}: {text[:200]}")
    note_running_usage({"serpapi": 1})
    return body


def _get(params: dict) -> dict:
    key = resolve_serp_key()
    if not key:
        raise RuntimeError("SerpAPI key is missing. Add SERPAPI_API_KEY to .env and restart the app.")
    try:
        return _get_once(key, params)
    except SerpExhausted:
        pref = serp_preference()
        keys = config.serp_api_keys()
        other = keys[1 if pref["active"] == 1 else 0]
        if not pref["auto"] or not other or other == key:
            raise
        save_serp_preference(active=2 if pref["active"] == 1 else 1, auto=True)
        clear_serp_key_sticky()
        return _get_once(other, params)


def _is_web_url(value) -> bool:
    return isinstance(value, str) and bool(re.match(r"^https?://", value, re.I))


def search_images(query: str, page_index: int) -> list[dict]:
    body = _get({"engine": "google_images", "q": query, "ijn": str(page_index), "tbs": "isz:l"})
    hits = []
    for item in body.get("images_results") or []:
        if not _is_web_url(item.get("original")):
            continue
        hits.append({
            "original": item["original"],
            "width": item.get("original_width"),
            "height": item.get("original_height"),
            "title": (item.get("title") or "").strip(),
            "source": (item.get("source") or "").strip(),
            "pageUrl": item["link"] if _is_web_url(item.get("link")) else "",
        })
    return hits


def upload_lens_image(jpeg: bytes) -> str:
    """Sends the user's photo to SerpAPI. The returned id is used for the Lens search. Not a search."""
    key = resolve_serp_key()
    if not key:
        raise RuntimeError("SerpAPI key is missing. Add SERPAPI_API_KEY to .env and restart the app.")
    try:
        response = requests.post(
            f"{config.serp_api_base_url()}/image",
            data={"api_key": key},
            files={"image": ("product.jpg", jpeg, "image/jpeg")},
            timeout=60,
        )
    except requests.RequestException as error:
        raise RuntimeError(f"Could not reach SerpAPI: {error}") from error
    try:
        body = response.json()
    except ValueError:
        body = None
    if not response.ok or not isinstance(body, dict) or not body.get("image_id"):
        raise RuntimeError((body or {}).get("error") if isinstance(body, dict) and body.get("error") else f"SerpAPI image upload returned HTTP {response.status_code}")
    return body["image_id"]


def lens_search(image_id: str, limit: int = 20) -> list[dict]:
    body = _get({"engine": "google_lens", "type": "visual_matches", "image_id": image_id, "hl": "en"})
    hits = []
    seen: set[str] = set()
    for item in body.get("visual_matches") or []:
        image = item.get("image")
        if not _is_web_url(image) or image in seen:
            continue
        seen.add(image)
        hits.append({
            "original": image,
            "width": item.get("image_width"),
            "height": item.get("image_height"),
            "title": (item.get("title") or "").strip(),
            "source": (item.get("source") or "").strip(),
            "pageUrl": "",
            "imageOnly": True,
        })
        if len(hits) >= limit:
            break
    return hits

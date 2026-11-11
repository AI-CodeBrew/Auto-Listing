"""Stores an uploaded photo is matched against."""
from __future__ import annotations

import re

from ..jsurl import URL, URLError

MARKETPLACES = [
    {"id": "amazon", "label": "Amazon", "host": "amazon.com"},
    {"id": "aliexpress", "label": "AliExpress", "host": "aliexpress.com"},
    {"id": "alibaba", "label": "Alibaba", "host": "alibaba.com"},
]
MARKETPLACE_PHOTO_LIMIT = 20

HOST = {
    "amazon": re.compile(r"(^|\.)(media-amazon\.com|ssl-images-amazon\.com|images-amazon\.com|amazon\.(com|[a-z]{2,3}(\.[a-z]{2})?))$", re.I),
    "aliexpress": re.compile(r"(^|\.)aliexpress\.[a-z.]+$", re.I),
    "alibaba": re.compile(r"(^|\.)alibaba\.com$", re.I),
}


def _by_host(raw: str | None) -> dict | None:
    if not raw:
        return None
    try:
        host = re.sub(r"^www\.", "", URL(raw).hostname.lower())
    except URLError:
        return None
    return next((m for m in MARKETPLACES if HOST[m["id"]].search(host)), None)


def _by_name(source: str) -> dict | None:
    text = (source or "").lower()
    if "aliexpress" in text:
        return MARKETPLACES[1]
    if "alibaba" in text:
        return MARKETPLACES[2]
    if "amazon" in text:
        return MARKETPLACES[0]
    return None


def marketplace_of_hit(hit: dict) -> dict | None:
    return _by_host(hit.get("pageUrl")) or _by_host(hit.get("original")) or _by_name(hit.get("source") or "")


def marketplace_label(page_url: str | None) -> str | None:
    market = _by_host(page_url)
    return market["label"] if market else None


def take_marketplace_photos(groups: list[list[dict]], limit: int = MARKETPLACE_PHOTO_LIMIT) -> list[dict]:
    seen: set[str] = set()
    chosen: list[dict] = []
    index = 0
    while len(chosen) < limit:
        added = False
        for group in groups:
            if index >= len(group):
                continue
            hit = group[index]
            if hit["original"] in seen:
                continue
            seen.add(hit["original"])
            chosen.append(hit)
            added = True
            if len(chosen) >= limit:
                break
        if not added:
            break
        index += 1
    return chosen

"""Find Creatives: the product's best YouTube videos and Meta (Facebook/Instagram) ads."""
from __future__ import annotations

import json
import math
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from urllib.parse import quote, urlencode

import requests

from . import config, db
from .ai import identify_product_image, match_product_thumbnails
from .config import LIMITS
from .jsurl import URL, URLError
from .media.images import for_vision
from .storage import commit_file, remove_quietly, temp_path
from .web.net import FetchError, TooLargeError, download_to_file


class CreativeError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


CACHE_S = 24 * 60 * 60
TOP_SOURCE = 15
TOP_COMBINED = 20


def _parse_date(value: str) -> float | None:
    if not value:
        return None
    try:
        text = value.replace("Z", "+00:00")
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp() * 1000
    except ValueError:
        return None


def _now_ms() -> float:
    return time.time() * 1000


# ---------- Scoring ----------

def score_video(views: float, likes: float, comments: float, published_at: str, now: float | None = None) -> dict | None:
    published = _parse_date(published_at)
    if published is None:
        return None
    now = _now_ms() if now is None else now
    days_live = max(1, (now - published) / 86_400_000)
    views_per_day = views / days_live
    engagement = (likes + comments * 2) / views if views > 0 else 0
    return {"daysLive": days_live, "viewsPerDay": views_per_day, "engagement": engagement, "score": views_per_day * (1 + engagement * 10)}


def score_meta_ad(start: str, stop: str | None, reach: float, duplicates: int, now: float | None = None) -> dict | None:
    began = _parse_date(start)
    if began is None:
        return None
    now = _now_ms() if now is None else now
    parsed_stop = _parse_date(stop) if stop else now
    end = parsed_stop if parsed_stop is not None else now
    days_running = max(1, (end - began) / 86_400_000)
    if days_running < 3:
        return None
    is_active = not stop
    score = days_running * (1.5 if is_active else 1) * math.log10(reach + 10) * (1 + duplicates * 0.2)
    return {"daysRunning": days_running, "isActive": is_active, "score": score}


def apply_normalized_scores(items: list[dict]) -> list[dict]:
    if not items:
        return items
    scores = [i["score"] for i in items]
    low, high = min(scores), max(scores)
    span = high - low
    return [{**i, "normalizedScore": 100 if span == 0 else round(((i["score"] - low) / span) * 1000) / 10} for i in items]


def _number(value) -> float:
    try:
        parsed = float(value or 0)
    except (TypeError, ValueError):
        return 0
    return parsed if math.isfinite(parsed) and parsed > 0 else 0


# ---------- YouTube ----------

SEARCH_UNITS = 100
STATS_UNITS = 1
MIN_VIEWS = 1000
PER_SEARCH = 30
THUMBNAILS_TO_CHECK = 30


def _youtube(path: str, params: dict) -> dict:
    key = config.youtube_api_key()
    if not key:
        raise CreativeError("YOUTUBE_API_KEY is missing. Add it to backend/.env and restart the app.", 500)
    try:
        response = requests.get(f"https://www.googleapis.com/youtube/v3/{path}", params={**params, "key": key}, timeout=30)
    except requests.RequestException as error:
        raise CreativeError("Could not reach YouTube. Check your internet connection.", 502) from error
    try:
        body = response.json() if response.text else {}
    except ValueError:
        body = {}
    if not response.ok:
        error = body.get("error") or {}
        reason = ((error.get("errors") or [{}])[0]).get("reason") or ""
        message = error.get("message") or ""
        print(f"[creatives] youtube {path} {response.status_code} {reason or 'error'}")
        if response.status_code == 403 and (reason == "quotaExceeded" or re.search("quota", message, re.I)):
            raise CreativeError("Daily limit reached, try again tomorrow.", 429)
        if reason in ("keyInvalid", "accessNotConfigured") or re.search("API key", message, re.I):
            raise CreativeError("YouTube rejected YOUTUBE_API_KEY. Check the key in backend/.env and restart the app.", 502)
        raise CreativeError("YouTube search failed. Try again shortly.", 502)
    return body


def _search_youtube(keywords: list[str], shorts_only: bool, published_after: str) -> tuple[list[str], int]:
    ids: list[str] = []
    quota = 0
    for keyword in keywords:
        params = {"part": "id", "q": keyword, "type": "video", "order": "viewCount", "maxResults": str(PER_SEARCH), "publishedAfter": published_after}
        if shorts_only:
            params["videoDuration"] = "short"
        body = _youtube("search", params)
        quota += SEARCH_UNITS
        for item in body.get("items") or []:
            video_id = (item.get("id") or {}).get("videoId")
            if video_id and video_id not in ids:
                ids.append(video_id)
    return ids, quota


def _stats(ids: list[str]) -> tuple[list[dict], int]:
    videos: list[dict] = []
    quota = 0
    for start in range(0, len(ids), 50):
        body = _youtube("videos", {"part": "snippet,statistics,contentDetails", "id": ",".join(ids[start : start + 50])})
        quota += STATS_UNITS
        videos.extend(item for item in body.get("items") or [] if item.get("id"))
    return videos, quota


def _to_creative(item: dict) -> dict | None:
    stats = item.get("statistics") or {}
    snippet = item.get("snippet") or {}
    views, likes, comments = _number(stats.get("viewCount")), _number(stats.get("likeCount")), _number(stats.get("commentCount"))
    published = snippet.get("publishedAt") or ""
    scored = score_video(views, likes, comments, published)
    if not item.get("id") or not scored:
        return None
    thumbs = snippet.get("thumbnails") or {}
    thumbnail = next((thumbs[k]["url"] for k in ("medium", "high", "default", "standard") if (thumbs.get(k) or {}).get("url")), "")
    title = (snippet.get("title") or "").strip() or "Untitled video"
    return {
        "source": "youtube",
        "id": item["id"],
        "title": title,
        "text": (snippet.get("description") or "").strip() or title,
        "author": (snippet.get("channelTitle") or "").strip() or "Unknown channel",
        "url": f"https://www.youtube.com/watch?v={quote(item['id'], safe='')}",
        "thumbnail": thumbnail,
        "startedAt": published,
        "metrics": {
            "views": views,
            "likes": likes,
            "viewsPerDay": round(scored["viewsPerDay"], 1),
            "engagementPct": round(scored["engagement"] * 100, 2),
        },
        "score": scored["score"],
        "normalizedScore": 0,
    }


def _thumbnail_jpeg(url: str) -> bytes | None:
    tmp = temp_path("creatives", "images")
    try:
        download_to_file(url, tmp, 2_000_000, 15_000)
        return for_vision(tmp)
    except Exception:  # noqa: BLE001
        return None
    finally:
        remove_quietly(tmp)


def collect_youtube(keywords: list[str], shorts_only: bool, published_after: str, image: bytes) -> dict:
    quota = 0
    try:
        ids, used = _search_youtube(keywords, shorts_only, published_after)
        quota += used
        videos, used = _stats(ids) if ids else ([], 0)
        quota += used
        ranked = [c for c in (_to_creative(v) for v in videos) if c and c["metrics"]["views"] >= MIN_VIEWS]
        ranked.sort(key=lambda c: c["score"], reverse=True)
        candidates = ranked[:THUMBNAILS_TO_CHECK]
        queue = [c for c in candidates if c["thumbnail"]]
        with ThreadPoolExecutor(max_workers=max(1, min(6, len(queue)))) as pool:
            datas = list(pool.map(lambda c: _thumbnail_jpeg(c["thumbnail"]), queue))
        thumbs = [{"id": c["id"], "data": d} for c, d in zip(queue, datas) if d]
        if not thumbs and queue:
            raise CreativeError("The video thumbnails could not be checked. Try again.", 502)
        matched = set(match_product_thumbnails(image, thumbs)) if thumbs else set()
        return {"items": [c for c in candidates if c["id"] in matched], "quota": quota, "checked": len(candidates)}
    except Exception:
        if quota > 0:
            print(f"[creatives] youtube quota used {quota} before failure")
        raise


# ---------- Meta Ad Library ----------

GRAPH = "https://graph.facebook.com/v21.0/ads_archive"
COUNTRIES = ["DE", "FR", "GB", "IT", "ES", "NL"]
FIELDS = ",".join([
    "id", "page_id", "page_name", "ad_snapshot_url", "ad_creative_bodies", "ad_creative_link_titles", "ad_creative_link_captions",
    "ad_delivery_start_time", "ad_delivery_stop_time", "publisher_platforms", "eu_total_reach", "languages",
])


def _meta_get(url: str) -> dict:
    try:
        response = requests.get(url, timeout=30)
    except requests.RequestException as error:
        raise CreativeError("Could not reach the Meta Ad Library. Check your internet connection.", 502) from error
    try:
        body = response.json() if response.text else {}
    except ValueError:
        body = {}
    if not response.ok or body.get("error"):
        error = body.get("error") or {}
        code = error.get("code") or response.status_code
        message = error.get("message") or ""
        print(f"[creatives] meta {code}")
        if code == 190:
            raise CreativeError("Meta token expired, refresh it", 502)
        if code in (10, 200, 270) or re.search(r"permission|not authorized|identity|ads_archive|verify your identity", message, re.I):
            raise CreativeError("Meta Ad Library access not approved yet", 502)
        raise CreativeError("Meta Ad Library search failed. Try again shortly.", 502)
    return body


def _is_graph_url(raw: str) -> bool:
    try:
        url = URL(raw)
    except URLError:
        return False
    return url.protocol == "https:" and url.hostname == "graph.facebook.com"


def search_meta_ads(keyword: str) -> list[dict]:
    token = config.meta_access_token()
    if not token:
        raise CreativeError("META_ACCESS_TOKEN is missing. Add it to backend/.env and restart the app.", 500)
    params = urlencode({
        "search_terms": keyword, "ad_type": "ALL", "ad_active_status": "ALL",
        "ad_reached_countries": json.dumps(COUNTRIES, separators=(",", ":")),
        "publisher_platforms": json.dumps(["FACEBOOK", "INSTAGRAM"], separators=(",", ":")),
        "limit": "50", "fields": FIELDS, "access_token": token,
    })
    ads: list[dict] = []
    nxt: str | None = f"{GRAPH}?{params}"
    for _ in range(2):
        if not nxt:
            break
        body = _meta_get(nxt)
        ads.extend(ad for ad in body.get("data") or [] if ad.get("id"))
        more = (body.get("paging") or {}).get("next")
        nxt = more if more and _is_graph_url(more) else None
    return ads


def _group_key(ad: dict) -> str:
    return f"{ad.get('page_id') or ''}::{(ad.get('ad_creative_bodies') or [''])[0]}"


def collect_meta_ads(keywords: list[str]) -> list[dict]:
    with ThreadPoolExecutor(max_workers=max(1, len(keywords))) as pool:
        lists = list(pool.map(search_meta_ads, keywords))
    by_id: dict[str, dict] = {}
    for ad in (a for lst in lists for a in lst):
        by_id.setdefault(ad["id"], ad)
    ads = list(by_id.values())
    groups: dict[str, int] = {}
    for ad in ads:
        groups[_group_key(ad)] = groups.get(_group_key(ad), 0) + 1
    ranked = []
    for ad in ads:
        body = re.sub(r"\s+", " ", (ad.get("ad_creative_bodies") or [""])[0] or "").strip()
        duplicates = groups.get(_group_key(ad), 1)
        reach = _number(ad.get("eu_total_reach"))
        scored = score_meta_ad(ad.get("ad_delivery_start_time") or "", ad.get("ad_delivery_stop_time") or None, reach, duplicates)
        if not scored:
            continue
        platforms = [p for p in ad.get("publisher_platforms") or [] if p in ("FACEBOOK", "INSTAGRAM")]
        shown = platforms or ["FACEBOOK"]
        instagram_only = "INSTAGRAM" in shown and "FACEBOOK" not in shown
        title = re.sub(r"\s+", " ", (ad.get("ad_creative_link_titles") or [""])[0] or body or "Untitled ad").strip()
        ranked.append({
            "source": "instagram" if instagram_only else "facebook",
            "id": ad["id"],
            "title": title[:300],
            "text": body,
            "author": (ad.get("page_name") or "").strip() or "Unknown page",
            "url": ad.get("ad_snapshot_url") or f"https://www.facebook.com/ads/library/?id={quote(ad['id'], safe='')}",
            "thumbnail": "",
            "startedAt": ad.get("ad_delivery_start_time") or "",
            "metrics": {"daysRunning": max(3, round(scored["daysRunning"])), "isActive": scored["isActive"], "reach": reach, "duplicates": duplicates, "platforms": list(shown)},
            "score": scored["score"],
            "normalizedScore": 0,
        })
    return sorted(ranked, key=lambda r: r["score"], reverse=True)


# ---------- Find ----------

def _clip(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def _clean_keywords(words: list[str]) -> list[str]:
    out: list[str] = []
    for word in words:
        clean = re.sub(r"\s+", " ", word or "").strip()
        if 1 < len(clean) <= 120 and clean not in out:
            out.append(clean)
    return out[:8]


def analyze_image(jpeg: bytes) -> dict:
    draft = identify_product_image(jpeg)
    brand, model, color, packaging = _clip(draft["brand"]), _clip(draft["model"]), _clip(draft["color"]), _clip(draft["packagingText"])
    seen = _clip(draft["title"])
    specific = [x for x in (brand, model, color) if x]
    title = (seen if seen and (not brand or brand.lower() in seen.lower()) else " ".join(specific))[:200]
    arabic = next((w for w in map(_clip, draft["keywords"]) if re.search(r"[؀-ۿ]", w)), None)
    color_in_name = bool(color and color.lower() in title.lower())
    third = f"{color} {title}" if title and color and not color_in_name else (f"{title} {packaging}" if packaging else "")
    keywords = _clean_keywords([
        f"{title} review" if title else "",
        f"{title} tiktok made me buy it" if title else "",
        third,
        arabic or "",
        *draft["keywords"],
    ])[:4]
    if not title or not keywords:
        raise CreativeError("The image could not be identified as a product. Try a clearer photo.")
    return {"brand": brand, "model": model, "color": color, "packagingText": packaging, "title": title, "keywords": keywords}


def _load_image(image: bytes | None, image_url: str | None) -> bytes:
    if image is not None:
        if not image or len(image) > LIMITS.image_max_bytes:
            raise CreativeError("Images can be at most 20 MB." if image else "That file is not a readable image.")
        try:
            return for_vision(image)
        except Exception as error:  # noqa: BLE001
            raise CreativeError("That file is not a readable image.") from error
    url = (image_url or "").strip()
    if not url:
        raise CreativeError("Upload a product image or paste an image URL.")
    tmp = temp_path("creatives", "images")
    try:
        download_to_file(url, tmp, LIMITS.image_max_bytes, 30_000)
        return for_vision(tmp)
    except TooLargeError as error:
        raise CreativeError("Images can be at most 20 MB.") from error
    except FetchError as error:
        raise CreativeError("That image address is not allowed." if str(error).startswith("Blocked") else "That image address could not be opened.") from error
    except CreativeError:
        raise
    except Exception as error:  # noqa: BLE001
        raise CreativeError("That file is not a readable image.") from error
    finally:
        remove_quietly(tmp)


def _store_image(jpeg: bytes) -> None:
    tmp = temp_path("creatives", "images")
    with open(tmp, "wb") as handle:
        handle.write(jpeg)
    commit_file("creatives", "images", tmp, "jpg")


def _clamp_days(days) -> int:
    try:
        value = float(days)
    except (TypeError, ValueError):
        return 180
    if not math.isfinite(value) or value <= 0:
        return 180
    return int(min(365, max(7, round(value))))


def _cache_key(title: str, keywords: list[str], shorts_only: bool, days: int) -> str:
    return json.dumps(["sources-v3", title.strip().lower(), "short" if shorts_only else "any", days, sorted(k.lower() for k in keywords)], separators=(",", ":"), ensure_ascii=False)


def _read_cache(key: str) -> dict | None:
    row = db.one("SELECT payload, created_at FROM creative_cache WHERE cache_key = ?", (key,))
    if not row:
        return None
    created = _parse_date(row["created_at"]) or 0
    if _now_ms() - created > CACHE_S * 1000:
        db.execute("DELETE FROM creative_cache WHERE cache_key = ?", (key,))
        return None
    try:
        saved = json.loads(row["payload"])
    except ValueError:
        return None
    if not saved.get("product") or not all(isinstance(saved.get(k), list) for k in ("youtube", "meta", "combined")):
        return None
    return {**saved, "quotaUsed": 0, "cached": True, "warnings": saved.get("warnings") or []}


def _write_cache(key: str, result: dict) -> None:
    db.execute(
        """INSERT INTO creative_cache (cache_key, payload, created_at) VALUES (?, ?, ?)
           ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at""",
        (key, json.dumps(result), datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")),
    )


def find_creatives(*, image: bytes | None = None, image_url: str | None = None, title: str = "", brand: str = "", model: str = "", color: str = "", packaging_text: str = "", keywords: list[str] | None = None, shorts_only: bool = True, days=180) -> dict:
    days = _clamp_days(days)
    title = _clip(title)[:200]
    keywords = _clean_keywords(keywords or [])
    brand, model, color, packaging_text = _clip(brand), _clip(model), _clip(color), _clip(packaging_text)

    jpeg = _load_image(image, image_url)
    _store_image(jpeg)
    if not keywords:
        found = analyze_image(jpeg)
        title, keywords = found["title"], found["keywords"]
        brand, model, color, packaging_text = found["brand"], found["model"], found["color"], found["packagingText"]
    if not title or not keywords:
        raise CreativeError("Upload a product image or paste an image URL.")

    key = _cache_key(title, keywords, shorts_only, days)
    cached = _read_cache(key)
    if cached:
        print(f'[creatives] quota used 0 for "{cached["product"]}" (cached)')
        return cached

    published_after = datetime.fromtimestamp(time.time() - days * 86400, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

    def source_message(error: Exception, fallback: str) -> str:
        return error.message if isinstance(error, CreativeError) else fallback

    def youtube_part():
        try:
            return {**collect_youtube(keywords, shorts_only, published_after, jpeg), "warning": None}
        except Exception as error:  # noqa: BLE001
            return {"items": [], "quota": 0, "checked": 0, "warning": source_message(error, "YouTube search failed. Try again shortly.")}

    def meta_part():
        try:
            return {"items": collect_meta_ads(keywords), "warning": None}
        except Exception as error:  # noqa: BLE001
            return {"items": [], "warning": source_message(error, "Meta Ad Library search failed. Try again shortly.")}

    with ThreadPoolExecutor(max_workers=2) as pool:
        yt_future = pool.submit(youtube_part)
        meta_future = pool.submit(meta_part)
        yt, meta = yt_future.result(), meta_future.result()

    warnings = [w for w in (yt["warning"], meta["warning"]) if w]
    youtube = sorted(apply_normalized_scores(yt["items"]), key=lambda i: i["score"], reverse=True)[:TOP_SOURCE]
    meta_items = sorted(apply_normalized_scores(meta["items"]), key=lambda i: i["score"], reverse=True)[:TOP_SOURCE]
    combined = sorted([*youtube, *meta_items], key=lambda i: (i["normalizedScore"], i["score"]), reverse=True)[:TOP_COMBINED]
    result = {
        "product": title, "brand": brand, "model": model, "color": color, "packagingText": packaging_text,
        "keywords": keywords, "quotaUsed": yt["quota"], "cached": False, "checked": yt["checked"], "warnings": warnings,
        "youtube": youtube, "meta": meta_items, "combined": combined,
    }
    _write_cache(key, result)
    print(f'[creatives] youtube quota {result["quotaUsed"]}, meta {len(meta["items"])}, matched videos {len(youtube)} for "{title}"')
    return result

"""TikTok videos for a product through the FastMoss MCP server."""
from __future__ import annotations

import json
import re
from urllib.parse import quote

import requests

from .. import config
from ..jsurl import URL, URLError
from ..repo import note_running_usage
from ..settings import fastmoss_api_key

TEXT_FIELDS = ["keywords", "keyword", "query", "q", "word", "words", "search", "title", "video_title"]
REGION_FIELDS = ["region", "country", "market", "region_code"]
LIMIT_FIELDS = ["page_size", "limit", "size", "pageSize"]
URL_FIELDS = ["tiktok_url", "video_url", "share_url", "url", "fastmoss_url", "play_url", "video_play_url"]
TITLE_FIELDS = ["title", "video_desc", "desc", "description", "video_title"]
CREATOR_FIELDS = ["nickname", "author_name", "creator_name", "unique_id", "author"]


def video_search_arguments(schema: dict | None, query: str) -> dict:
    properties = (schema or {}).get("properties") or {}
    names = list(properties.keys())
    args: dict = {}
    text_name = next((n for n in TEXT_FIELDS if n in names), None)
    region_name = next((n for n in REGION_FIELDS if n in names), None)
    if text_name:
        args[text_name] = query
    elif not names:
        args["keywords"] = query
    else:
        required = (schema or {}).get("required") or []
        for name in [*required, *names]:
            kind = (properties.get(name) or {}).get("type")
            if name != region_name and (not kind or kind == "string"):
                args[name] = query
                break
    if region_name:
        options = [str(v) for v in (properties[region_name].get("enum") or [])]
        us = next((v for v in options if re.match(r"^(us|usa)$", v, re.I) or re.search(r"united states", v, re.I)), None)
        args[region_name] = us or (options[0] if options else "US")
    elif not names:
        args["region"] = "US"
    limit_name = next((n for n in LIMIT_FIELDS if n in names), None)
    if limit_name:
        args[limit_name] = 8
    return args


def _first_string(record: dict, keys: list[str]) -> str:
    for key in keys:
        value = record.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _http_url(value: str) -> str:
    try:
        url = URL(value)
    except URLError:
        return ""
    return url.href if url.protocol in ("http:", "https:") else ""


def _looks_like_image(url: str) -> bool:
    try:
        return bool(re.search(r"\.(jpe?g|png|gif|webp|avif|svg)$", URL(url).pathname, re.I))
    except URLError:
        return False


def videos_from_payload(payload, limit: int = 8) -> list[dict]:
    found: list[dict] = []
    seen: set[str] = set()

    def visit(value) -> None:
        if len(found) >= limit:
            return
        if isinstance(value, str):
            trimmed = value.strip()
            if trimmed.startswith("{") or trimmed.startswith("["):
                try:
                    visit(json.loads(trimmed))
                except ValueError:
                    pass
            return
        if isinstance(value, list):
            for item in value:
                visit(item)
            return
        if not isinstance(value, dict):
            return
        record = value
        candidates = [c for c in (_http_url(record[k]) if isinstance(record.get(k), str) else "" for k in URL_FIELDS) if c and not _looks_like_image(c)]
        video_id = _first_string(record, ["video_id", "aweme_id", "item_id", "videoId"])
        user = re.sub(r"^@", "", _first_string(record, ["unique_id", "author_unique_id"]))
        playable = next((c for c in candidates if re.search(r"tiktok\.com|youtube\.com|youtu\.be|vimeo\.com", c, re.I)), None)
        fastmoss_page = next((c for c in candidates if re.search(r"fastmoss\.com", c, re.I)), "")
        built = f"https://www.tiktok.com/@{quote(user, safe='')}/video/{quote(video_id, safe='')}" if video_id and user else ""
        url = playable or built or fastmoss_page or next((c for c in candidates if re.search(r"/video/", c, re.I)), "")
        if url and url not in seen:
            seen.add(url)
            found.append({
                "url": url,
                "title": _first_string(record, TITLE_FIELDS),
                "creator": _first_string(record, CREATOR_FIELDS),
                "pageUrl": fastmoss_page if fastmoss_page and fastmoss_page != url else "",
            })
        for nested in record.values():
            visit(nested)

    visit(payload)
    return found[:limit]


def _parse_rpc(text: str) -> dict:
    trimmed = text.strip()
    if not trimmed:
        raise RuntimeError("FastMoss returned an empty response.")
    if trimmed.startswith("{"):
        return json.loads(trimmed)
    data = [line[5:].strip() for line in trimmed.split("\n") if line.startswith("data:")]
    data = [line for line in data if line and line != "[DONE]"]
    if not data:
        raise RuntimeError("FastMoss returned a response that was not JSON.")
    return json.loads(data[-1])


def _rpc(method: str, params, session_id: str = "") -> tuple[str, dict]:
    key = fastmoss_api_key()
    if not key:
        raise RuntimeError("No FastMoss API key is saved.")
    headers = {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
        "x-api-key": key,
        "mcp-protocol-version": "2025-03-26",
    }
    if session_id:
        headers["mcp-session-id"] = session_id
    message = {"jsonrpc": "2.0", "method": method, "params": params}
    if method != "notifications/initialized":
        message["id"] = 1
    try:
        response = requests.post(config.fastmoss_mcp_url(), headers=headers, data=json.dumps(message), timeout=60)
    except requests.RequestException as error:
        raise RuntimeError(f"Could not reach FastMoss. Check your internet connection. {error}".strip()) from error
    if response.status_code in (401, 403):
        raise RuntimeError("FastMoss rejected FASTMOSS_API_KEY. Check the key in .env and restart the app.")
    try:
        body = _parse_rpc(response.text)
    except (RuntimeError, ValueError) as error:
        if not response.ok:
            raise RuntimeError(f"FastMoss returned HTTP {response.status_code}.") from error
        raise RuntimeError(str(error) if isinstance(error, RuntimeError) else "FastMoss returned a response that was not JSON.") from error
    if (body.get("error") or {}).get("message"):
        raise RuntimeError(f"FastMoss error: {body['error']['message']}")
    if not response.ok:
        raise RuntimeError(f"FastMoss returned HTTP {response.status_code}.")
    return response.headers.get("mcp-session-id") or session_id, body


_schema_cache: dict = {}


def _video_search_schema(session_id: str) -> dict | None:
    if "schema" in _schema_cache:
        return _schema_cache["schema"]
    try:
        _, listed = _rpc("tools/list", {}, session_id)
    except RuntimeError:
        return None
    tools = ((listed.get("result") or {}).get("tools")) or []
    tool = next((t for t in tools if t.get("name") == "video_search"), None)
    _schema_cache["schema"] = (tool or {}).get("inputSchema") or (tool or {}).get("input_schema")
    return _schema_cache["schema"]


def _open_session() -> str:
    session_id, _ = _rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "product-listing-assistant", "version": "1.0.0"}})
    try:
        _rpc("notifications/initialized", {}, session_id)
    except RuntimeError:
        pass
    return session_id


def test_fastmoss() -> dict:
    session_id = _open_session()
    _, listed = _rpc("tools/list", {}, session_id)
    return {"tools": len(((listed.get("result") or {}).get("tools")) or [])}


def search_videos(query: str) -> list[dict]:
    session_id = _open_session()
    schema = _video_search_schema(session_id)
    _, called = _rpc("tools/call", {"name": "video_search", "arguments": video_search_arguments(schema, query)}, session_id)
    note_running_usage({"fastmoss": 1})
    result = called.get("result") or {}
    if result.get("isError"):
        message = " ".join(i.get("text") for i in result.get("content") or [] if i.get("text")) or "FastMoss could not search videos."
        raise RuntimeError(message[:300])
    texts = [i.get("text") for i in result.get("content") or [] if i.get("text")]
    return videos_from_payload(texts if texts else called.get("result"))

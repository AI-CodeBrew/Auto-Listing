from __future__ import annotations

import re

from ..jsurl import URL, URLError

SOCIAL_HOSTS = [
    "facebook.com", "fb.com", "fb.watch", "instagram.com", "tiktok.com", "twitter.com", "x.com",
    "pinterest.com", "linkedin.com", "reddit.com", "youtube.com", "youtu.be", "vimeo.com",
    "snapchat.com", "threads.net", "tumblr.com", "quora.com", "discord.com", "telegram.org",
    "whatsapp.com", "wikipedia.org",
]
BLOG_HOSTS = ["medium.com", "blogspot.com", "wordpress.com", "substack.com", "wixsite.com", "weebly.com", "ghost.io"]
BLOG_PATH = re.compile(r"/(blog|blogs|news|article|articles|forum|forums|community|magazine|guide|guides|review|reviews|how-to|wiki)(/|$)", re.I)
BLOG_HOST_PREFIX = re.compile(r"^(blog|news|forum|community|magazine|wiki)\.", re.I)
TRACKING_PARAM = re.compile(r"^(utm_.+|gclid|fbclid|msclkid|mc_cid|mc_eid|ref|ref_|tag|cid|sr|qid|spm|igshid|_ga|_gl)$", re.I)


def host_matches(host: str, entries: list[str]) -> bool:
    return any(host == entry or host.endswith(f".{entry}") for entry in entries)


def _host(url: URL) -> str:
    return re.sub(r"^www\.", "", url.hostname.lower())


def exclusion_reason(raw: str) -> str | None:
    """Why a URL should not be used as a product page, or None if it is fine."""
    try:
        url = URL(raw)
    except URLError:
        return "Not a valid URL"
    if url.protocol not in ("http:", "https:"):
        return "Not a web page"
    host = _host(url)
    if host_matches(host, SOCIAL_HOSTS):
        return "Social media page"
    if host_matches(host, BLOG_HOSTS) or BLOG_HOST_PREFIX.search(host) or BLOG_PATH.search(url.pathname):
        return "Blog or article page"
    return None


def normalize_url(raw: str) -> str:
    """Normal form used to spot duplicates. Tracking parameters and fragments do not make a page unique."""
    url = URL(raw)
    url.hash = ""
    url.hostname = _host(url)
    pairs = [(k, v) for k, v in url.params() if not TRACKING_PARAM.match(k)]
    pairs.sort(key=lambda pair: pair[0])
    url.set_params(pairs)
    url.pathname = url.pathname.rstrip("/") or "/"
    if url.scheme != "https":
        url.scheme = "https"
        url.port = "" if url.port in ("443", "80") else url.port
    return url.href


def domain_of(raw: str) -> str:
    return _host(URL(raw))


def filter_product_urls(urls: list[str], seen: set[str]) -> dict:
    """Removes blogs, social pages and duplicates, including anything already in `seen`."""
    keep: list[str] = []
    dropped: list[dict] = []
    for url in urls:
        reason = exclusion_reason(url)
        if reason:
            dropped.append({"url": url, "reason": reason})
            continue
        key = normalize_url(url)
        if key in seen:
            continue
        seen.add(key)
        keep.append(url)
    return {"keep": keep, "dropped": dropped}


YOUTUBE_HOSTS = ["youtube.com", "youtube-nocookie.com", "youtu.be"]
NEVER_DOWNLOAD_CDNS = [
    "googlevideo.com", "ytimg.com", "fbcdn.net", "cdninstagram.com", "tiktokcdn.com", "tiktokcdn-us.com",
    "tiktokv.com", "muscdn.com", "byteoversea.com",
]


def classify_video(raw: str) -> dict | None:
    """YouTube, TikTok, Instagram and Facebook are only ever links. Only direct MP4, MOV or WEBM URLs can become files."""
    try:
        url = URL(raw)
    except URLError:
        return None
    if url.protocol not in ("http:", "https:"):
        return None
    host = _host(url)
    if host_matches(host, YOUTUBE_HOSTS):
        if host == "youtu.be":
            video_id = url.pathname[1:].split("/")[0]
        else:
            match = re.search(r"/(?:embed|shorts|v|live)/([\w-]+)", url.pathname)
            video_id = url.get_param("v") or (match.group(1) if match else None)
        return {"kind": "link", "provider": "youtube", "url": f"https://www.youtube.com/watch?v={video_id}"} if video_id else None
    if host_matches(host, ["vimeo.com"]):
        match = re.search(r"(\d{6,})", url.pathname)
        return {"kind": "link", "provider": "vimeo", "url": f"https://vimeo.com/{match.group(1)}"} if match else None
    if host_matches(host, ["tiktok.com"]):
        return {"kind": "link", "provider": "tiktok", "url": raw}
    if host_matches(host, ["instagram.com"]):
        return {"kind": "link", "provider": "instagram", "url": raw}
    if host_matches(host, ["facebook.com", "fb.com", "fb.watch"]):
        return {"kind": "link", "provider": "facebook", "url": raw}
    if host_matches(host, NEVER_DOWNLOAD_CDNS):
        return None
    return {"kind": "file", "url": raw} if re.search(r"\.(mp4|mov|webm)$", url.pathname, re.I) else None


def video_extension(content_type: str, url: str) -> str | None:
    if "video/mp4" in content_type:
        return "mp4"
    if "video/quicktime" in content_type:
        return "mov"
    if "video/webm" in content_type:
        return "webm"
    match = re.search(r"\.(mp4|mov|webm)$", URL(url).pathname, re.I)
    base = content_type.split(";")[0].strip()
    if match and re.match(r"^(application/octet-stream|binary/octet-stream|)$", base):
        return match.group(1).lower()
    return None

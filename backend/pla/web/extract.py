"""Pulls product data from an open page in priority order: JSON-LD, Open Graph, then the DOM."""
from __future__ import annotations

import json
import re

from ..config import LIMITS
from ..jsurl import URL, URLError
from ..sanitize import to_plain_text
from .urls import domain_of

COLLECT_SCRIPT = r"""(() => {
  const meta = {};
  for (const el of document.querySelectorAll('meta[property^="og:"], meta[name^="og:"]')) {
    const key = el.getAttribute('property') || el.getAttribute('name');
    const value = el.getAttribute('content');
    if (key && value) (meta[key.toLowerCase()] = meta[key.toLowerCase()] || []).push(value);
  }
  const main = document.querySelector('main, [role="main"], article, #product, .product') || document.body;
  const clone = main ? main.cloneNode(true) : null;
  if (clone) for (const el of clone.querySelectorAll('script, style, noscript, nav, footer, header, form, aside')) el.remove();
  const zoomAttrs = ['data-zoom-image', 'data-zoom', 'data-large_image', 'data-large-image', 'data-old-hires', 'data-full', 'data-original', 'data-src'];
  const domImages = [];
  for (const img of document.images) {
    let zoom = '';
    for (const attr of zoomAttrs) { const v = img.getAttribute(attr); if (v) { zoom = v; break; } }
    const parent = img.closest('a[href]');
    const link = parent && /\.(jpe?g|png|webp)(\?|$)/i.test(parent.getAttribute('href') || '') ? parent.href : '';
    const picture = img.closest('picture');
    let srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset') || '';
    if (picture) for (const s of picture.querySelectorAll('source[srcset]')) srcset += ',' + s.getAttribute('srcset');
    const rect = img.getBoundingClientRect();
    domImages.push({ src: img.currentSrc || img.src || '', srcset, zoom, link, alt: img.alt || '',
      naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, width: rect.width, height: rect.height });
  }
  const videoSources = [];
  for (const v of document.querySelectorAll('video')) {
    if (v.src) videoSources.push(v.src);
    for (const s of v.querySelectorAll('source[src]')) videoSources.push(s.src);
  }
  const frames = [...document.querySelectorAll('iframe[src], iframe[data-src]')].map(f => f.src || f.getAttribute('data-src') || '');
  return {
    url: location.href,
    documentTitle: document.title || '',
    jsonLd: [...document.querySelectorAll('script[type="application/ld+json"]')].map(s => s.textContent || ''),
    og: meta,
    h1: (document.querySelector('h1') || {}).innerText || '',
    mainText: clone ? (clone.innerText || clone.textContent || '').slice(0, 60000) : '',
    domImages, videoSources, frames,
  };
})()"""

SCROLL_SCRIPT = """new Promise((resolve) => {
  let y = 0; const step = Math.max(window.innerHeight, 600); const max = Math.min(document.body ? document.body.scrollHeight : 0, 8000);
  const timer = setInterval(() => { y += step; window.scrollTo(0, y); if (y >= max) { clearInterval(timer); window.scrollTo(0, 0); resolve(null); } }, 80);
})"""


def _type_matches(node: dict, names: list[str]) -> bool:
    kind = node.get("@type")
    items = kind if isinstance(kind, list) else [kind]
    return any(isinstance(t, str) and any(t.lower().endswith(n) for n in names) for t in items)


def _collect_nodes(value, names: list[str], out: list[dict], depth: int = 0) -> None:
    if not value or not isinstance(value, (dict, list)) or depth > 8:
        return
    if isinstance(value, list):
        for item in value:
            _collect_nodes(item, names, out, depth + 1)
        return
    if _type_matches(value, names):
        out.append(value)
    for child in value.values():
        _collect_nodes(child, names, out, depth + 1)


def _first_string(value) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return _first_string(value[0]) if value else ""
    if isinstance(value, dict):
        for key in ("name", "url", "contentUrl"):
            if value.get(key) is not None:
                return _first_string(value[key])
        return ""
    return ""


def _json_ld_images(value) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [u for item in value for u in _json_ld_images(item)]
    if isinstance(value, dict):
        inner = value.get("contentUrl") if value.get("contentUrl") is not None else value.get("url", [])
        return _json_ld_images(inner)
    return []


def _seller_from_product(product: dict) -> str:
    direct = _first_string(product.get("seller"))
    if direct:
        return direct
    offers = product.get("offers")
    for offer in offers if isinstance(offers, list) else [offers]:
        if isinstance(offer, dict):
            seller = _first_string(offer.get("seller"))
            if seller:
                return seller
    return ""


def largest_from_srcset(srcset: str) -> str | None:
    best = None
    best_size = -1.0
    for part in re.split(r",\s+|,(?=https?:|/)", srcset):
        pieces = part.strip().split()
        if not pieces or not pieces[0]:
            continue
        url = pieces[0]
        descriptor = pieces[1] if len(pieces) > 1 else ""
        match = re.match(r"^([\d.]+)([wx])$", descriptor)
        size = float(match.group(1)) * (1000 if match.group(2) == "x" else 1) if match else 1
        if size > best_size:
            best_size, best = size, url
    return best


def full_size_guesses(raw: str) -> list[str]:
    try:
        url = URL(raw)
    except URLError:
        return []
    path = url.pathname
    stripped = re.sub(r"_(\d+x\d*|\d*x\d+|pico|icon|thumb|small|compact|medium|large|grande|master)(@\dx)?(?=\.\w+$)", "", path, count=1, flags=re.I)
    stripped = re.sub(r"-\d{2,4}x\d{2,4}(?=\.\w+$)", "", stripped, count=1)
    stripped = re.sub(r"\._[A-Z0-9_,]+_(?=\.\w+$)", "", stripped, count=1, flags=re.I)
    nxt = URL(url.href)
    nxt.pathname = stripped
    drop = {"width", "height", "w", "h", "size", "resize", "fit"}
    pairs = url.params()
    kept = [(k, v) for k, v in pairs if k not in drop]
    if len(kept) != len(pairs):
        nxt.set_params(kept)
    return [nxt.href] if nxt.href != raw else []


ICON_URL = re.compile(r"(^|[/_.-])(logo|logos|icon|icons|favicon|sprite|badge|avatar|payment|paypal|visa|mastercard|placeholder|spinner|loader)([/_.-]|\d|$)", re.I)


def looks_like_icon_or_logo(url: str, alt: str = "") -> bool:
    try:
        parsed = URL(url)
    except URLError:
        return True
    if re.search(r"\.(svg|ico)$", parsed.pathname, re.I):
        return True
    return bool(ICON_URL.search(parsed.pathname) or re.search(r"\b(logo|icon)\b", alt, re.I))


def _absolute(value: str, base: str) -> str | None:
    try:
        return URL(value, base).href
    except (URLError, ValueError):
        return None


def _build_images(raw: dict, json_ld: list[str], og: list[str]) -> list[dict]:
    out: list[dict] = []
    seen: set[str] = set()

    def add(url_value: str, alt: str, extra: list[str] | None = None) -> None:
        absolute = _absolute(url_value or "", raw["url"])
        if not absolute or not re.match(r"^https?:", absolute) or looks_like_icon_or_logo(absolute, alt) or absolute in seen:
            return
        extras = [u for u in (_absolute(e, raw["url"]) for e in (extra or [])) if u]
        urls: list[str] = []
        for u in [*extras, *full_size_guesses(absolute), absolute]:
            if u not in urls:
                urls.append(u)
        if urls[0] in seen:
            return
        seen.update(urls)
        out.append({"urls": urls, "alt": to_plain_text(alt)})

    for url in json_ld:
        add(url, "")
    for url in og:
        add(url, "")
    dom = [img for img in raw["domImages"] if img.get("src") or img.get("srcset") or img.get("zoom")]
    dom = [img for img in dom if max(img["naturalWidth"], img["width"]) >= 300 or img.get("srcset") or img.get("zoom") or img.get("link")]
    dom.sort(key=lambda img: img["naturalWidth"] * img["naturalHeight"], reverse=True)
    for img in dom:
        large = largest_from_srcset(img["srcset"]) if img.get("srcset") else None
        best = [v for v in (img.get("zoom"), img.get("link"), large) if v]
        add(img.get("src") or (best[0] if best else ""), img.get("alt", ""), best)
    return out[: LIMITS.images_per_page]


def extract_page(page) -> dict:
    try:
        page.evaluate(SCROLL_SCRIPT)
    except Exception:
        pass
    try:
        page.wait_for_load_state("networkidle", timeout=3_000)
    except Exception:
        pass
    raw = page.evaluate(COLLECT_SCRIPT)
    try:
        screenshot = page.screenshot(type="jpeg", quality=70)
    except Exception:
        screenshot = None

    products: list[dict] = []
    video_objects: list[dict] = []
    for block in raw["jsonLd"]:
        try:
            parsed = json.loads(block)
        except ValueError:
            continue
        _collect_nodes(parsed, ["product", "productgroup"], products)
        _collect_nodes(parsed, ["videoobject"], video_objects)
    product = products[0] if products else None

    def og(key: str) -> str:
        values = raw["og"].get(key) or []
        return values[0] if values else ""

    title = to_plain_text((product and _first_string(product.get("name"))) or og("og:title") or raw["h1"] or raw["documentTitle"])
    description = to_plain_text((product and _first_string(product.get("description"))) or og("og:description"))
    main_text = to_plain_text(raw["mainText"])
    text = "\n\n".join(t for t in (description, main_text) if t)[: LIMITS.source_text_chars]
    seller = to_plain_text(_seller_from_product(product) if product else "") or to_plain_text(og("og:site_name")) or domain_of(raw["url"])

    videos: list[str] = []
    for node in video_objects:
        for key in ("contentUrl", "embedUrl", "url"):
            value = _first_string(node.get(key))
            if value:
                videos.append(value)
    for key in ("og:video", "og:video:url", "og:video:secure_url"):
        videos.extend(raw["og"].get(key) or [])
    videos.extend(raw["videoSources"])
    videos.extend(raw["frames"])
    absolute_videos: list[str] = []
    for value in videos:
        absolute = _absolute(value, raw["url"])
        if absolute and absolute not in absolute_videos:
            absolute_videos.append(absolute)

    return {
        "url": raw["url"],
        "title": title,
        "description": description,
        "text": text,
        "seller": seller,
        "images": _build_images(raw, _json_ld_images(product.get("image")) if product else [], raw["og"].get("og:image") or []),
        "videos": absolute_videos,
        "screenshot": screenshot,
    }

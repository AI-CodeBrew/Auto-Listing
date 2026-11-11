"""Search for the no-SerpAPI path. With a SerpAPI key the app uses Google Images instead."""
from __future__ import annotations

import base64
import re
from urllib.parse import urlencode

from .. import config
from ..jsurl import URL, URLError
from ..web.browser import open_page, with_page
from ..web.errors import SearchDisallowedError
from ..web.robots import is_allowed_by_robots, polite_wait

COLLECT_LINKS = "[...document.querySelectorAll('li.b_algo h2 a, li.b_algo .b_title a')].map(a => a.href)"
NAME = "Bing"


def unwrap_bing_link(href: str) -> str | None:
    """Bing wraps results in bing.com/ck/a?...&u=a1<base64url>. The target is decoded and the redirect never followed."""
    try:
        url = URL(href)
    except URLError:
        return None
    if not re.search(r"(^|\.)bing\.com$", url.hostname, re.I):
        return href
    encoded = url.get_param("u")
    if not encoded or not encoded.startswith("a1"):
        return None
    try:
        body = encoded[2:]
        decoded = base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)).decode("utf-8")
    except Exception:
        return None
    return decoded if re.match(r"^https?://", decoded, re.I) else None


def search(query: str, offset: int) -> list[str]:
    params = {"q": query}
    if offset > 0:
        params["first"] = str(offset + 1)
    url = f"{config.bing_base_url()}/search?{urlencode(params)}"
    if not is_allowed_by_robots(url):
        raise SearchDisallowedError(url)
    polite_wait(url)

    def run(page):
        open_page(page, url)
        hrefs = page.evaluate(COLLECT_LINKS)
        return [link for link in (unwrap_bing_link(h) for h in hrefs) if link]

    return with_page(run)

"""Plain headless Chromium, one page at a time. No stealth plugins, spoofed fingerprint, proxies
or CAPTCHA solving. If a site refuses us, we stop and tell the user.

Playwright's sync API must stay on the thread that started it, so every page runs on one
dedicated browser thread. Callers hand it a function and wait for the result.
"""
from __future__ import annotations

import queue
import re
import threading
from concurrent.futures import Future
from typing import Any, Callable

from ..config import LIMITS
from ..jsurl import URL
from .errors import BlockedError
from .net import is_public_url

_tasks: "queue.Queue[tuple[Callable, Future] | None]" = queue.Queue()
_thread: threading.Thread | None = None
_thread_lock = threading.Lock()
_state: dict[str, Any] = {"pw": None, "browser": None}


def _ensure_browser():
    browser = _state["browser"]
    if browser is not None and browser.is_connected():
        return browser
    from playwright.sync_api import sync_playwright

    if _state["pw"] is None:
        _state["pw"] = sync_playwright().start()
    _state["browser"] = _state["pw"].chromium.launch(headless=True)
    return _state["browser"]


def _close_browser() -> None:
    browser = _state["browser"]
    _state["browser"] = None
    if browser is not None:
        try:
            browser.close()
        except Exception:
            pass


def _worker() -> None:
    while True:
        item = _tasks.get()
        if item is None:
            break
        fn, future = item
        if not future.set_running_or_notify_cancel():
            continue
        try:
            future.set_result(fn())
        except BaseException as error:  # noqa: BLE001 - handed back to the caller
            future.set_exception(error)


def _submit(fn: Callable) -> Any:
    global _thread
    with _thread_lock:
        if _thread is None or not _thread.is_alive():
            _thread = threading.Thread(target=_worker, name="pla-browser", daemon=True)
            _thread.start()
    if threading.current_thread() is _thread:
        return fn()
    future: Future = Future()
    _tasks.put((fn, future))
    return future.result()


def close_browser() -> None:
    _submit(_close_browser)


def with_page(fn: Callable[[Any], Any]) -> Any:
    """Runs fn with a fresh isolated page. Calls wait their turn, so only one page is ever open."""

    def run():
        browser = _ensure_browser()
        context = browser.new_context(accept_downloads=False, service_workers="block", viewport={"width": 1280, "height": 900})
        context.set_default_timeout(LIMITS.page_timeout_ms)
        context.set_default_navigation_timeout(LIMITS.page_timeout_ms)

        def guard(route):
            request = route.request
            if request.resource_type in ("media", "font", "websocket"):
                return route.abort()
            if request.url.startswith("data:") or request.url.startswith("blob:"):
                return route.continue_()
            # Untrusted pages may not reach local services, including this app's API.
            return route.continue_() if is_public_url(request.url) else route.abort("blockedbyclient")

        context.route("**/*", guard)
        try:
            page = context.new_page()
            return fn(page)
        finally:
            try:
                context.close()
            except Exception:
                pass

    return _submit(run)


CHALLENGE_TEXT = [re.compile(p, re.I) for p in (
    r"verify (that )?you('| a)re (a )?human",
    r"are you (a )?(human|robot)",
    r"robot or human",
    r"(press|activate) (&|and) hold",
    r"i('| a)m not a robot",
    r"complete the (security )?(check|challenge)",
    r"checking (if the site connection is secure|your browser)",
    r"unusual traffic",
    r"automated (requests|queries|access)",
    r"access (to this page )?(has been )?denied",
    r"pardon our interruption",
    r"enter the characters you see",
    r"please solve (this|the) (puzzle|captcha)",
    r"\bcaptcha\b",
)]
CHALLENGE_TITLE = re.compile(r"just a moment|attention required|access denied|security check|are you a (human|robot)|robot or human|captcha|robot check", re.I)
CHALLENGE_URL = re.compile(r"/(captcha|challenge|sorry|cdn-cgi/challenge-platform|distil_r_captcha)|[?&](captcha|challenge)=", re.I)
CHALLENGE_FRAME = 'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], iframe[src*="captcha"]'


def detect_block(page, response) -> str | None:
    status = response.status if response else 0
    url = page.url
    try:
        title = page.title()
    except Exception:
        title = ""
    try:
        text = str(page.evaluate("(document.body ? document.body.innerText : '').slice(0, 4000)"))
    except Exception:
        text = ""
    short_page = len(text.strip()) < 800
    parsed = URL(url)
    if CHALLENGE_URL.search(parsed.pathname + parsed.search):
        return "the site redirected to a challenge page"
    if CHALLENGE_TITLE.search(title):
        return f'the page title is "{title}"'
    if status == 429:
        return "the site answered HTTP 429 (too many requests)"
    if status == 403:
        return "the site answered HTTP 403 (forbidden)"
    if short_page:
        try:
            visible = page.locator(CHALLENGE_FRAME).first.is_visible()
        except Exception:
            visible = False
        if visible:
            return "the page shows a CAPTCHA"
        if any(pattern.search(text) for pattern in CHALLENGE_TEXT):
            return "the page asks for a human check"
    return None


def open_page(page, url: str):
    """Opens a URL and raises BlockedError if the result is a challenge page."""
    response = page.goto(url, wait_until="domcontentloaded", timeout=LIMITS.page_timeout_ms)
    try:
        page.wait_for_load_state("networkidle", timeout=5_000)
    except Exception:
        pass
    reason = detect_block(page, response)
    if reason:
        raise BlockedError(reason, url)
    return response

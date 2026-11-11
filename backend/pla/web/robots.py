"""robots.txt rules (RFC 9309: longest match wins, * and $ wildcards) and polite waiting."""
from __future__ import annotations

import re
import threading
import time
from urllib.parse import unquote

from .. import config
from ..jsurl import URL
from .net import safe_fetch, sleep_ms

CACHE_S = 3600
MAX_CRAWL_DELAY_MS = 10_000


class Rules:
    def __init__(self, text: str):
        self.groups: list[tuple[list[str], list[tuple[bool, str]], float | None]] = []
        agents: list[str] = []
        rules: list[tuple[bool, str]] = []
        delay: float | None = None
        last_was_agent = False
        for raw in text.splitlines():
            line = raw.split("#", 1)[0].strip()
            if not line or ":" not in line:
                continue
            field, value = line.split(":", 1)
            field = field.strip().lower()
            value = value.strip()
            if field == "user-agent":
                if not last_was_agent and agents:
                    self.groups.append((agents, rules, delay))
                    agents, rules, delay = [], [], None
                agents.append(value.lower())
                last_was_agent = True
                continue
            last_was_agent = False
            if not agents:
                continue
            if field in ("allow", "disallow"):
                if value or field == "allow":
                    rules.append((field == "allow", value))
            elif field == "crawl-delay":
                try:
                    delay = float(value)
                except ValueError:
                    pass
        if agents:
            self.groups.append((agents, rules, delay))

    def _group(self, ua: str):
        ua = ua.lower()
        best = None
        best_len = -1
        for agents, rules, delay in self.groups:
            for agent in agents:
                if agent != "*" and agent in ua and len(agent) > best_len:
                    best, best_len = (rules, delay), len(agent)
        if best:
            return best
        for agents, rules, delay in self.groups:
            if "*" in agents:
                return rules, delay
        return [], None

    @staticmethod
    def _matches(pattern: str, path: str) -> bool:
        regex = ""
        for char in pattern:
            if char == "*":
                regex += ".*"
            elif char == "$":
                regex += "$"
            else:
                regex += re.escape(char)
        return re.match(regex, path) is not None

    def is_allowed(self, url: str, ua: str) -> bool:
        parsed = URL(url)
        path = unquote(parsed.pathname + parsed.search)
        rules, _ = self._group(ua)
        verdict = True
        best = -1
        for allow, pattern in rules:
            if not pattern:
                continue
            if self._matches(unquote(pattern), path):
                length = len(pattern)
                if length > best or (length == best and allow):
                    best, verdict = length, allow
        return verdict

    def crawl_delay(self, ua: str) -> float:
        _, delay = self._group(ua)
        return delay or 0


_cache: dict[str, tuple[object, float]] = {}
_last_request: dict[str, float] = {}
_lock = threading.Lock()


def _rules_for(origin: str):
    with _lock:
        hit = _cache.get(origin)
    if hit and time.time() - hit[1] < CACHE_S:
        return hit[0]
    try:
        response, _ = safe_fetch(f"{origin}/robots.txt", timeout_ms=10_000)
        try:
            if response.ok:
                rules: object = Rules(response.text)
            else:
                # RFC 9309: 4xx means no rules apply. 5xx means assume everything is disallowed.
                rules = "deny-all" if response.status_code >= 500 else "allow-all"
        finally:
            response.close()
    except Exception:
        rules = "deny-all"
    with _lock:
        _cache[origin] = (rules, time.time())
    return rules


def is_allowed_by_robots(url: str) -> bool:
    rules = _rules_for(URL(url).origin)
    if rules == "allow-all":
        return True
    if rules == "deny-all":
        return False
    return rules.is_allowed(url, config.USER_AGENT_TOKEN)  # type: ignore[union-attr]


def polite_wait(url: str, base_delay_ms: int | None = None) -> None:
    base = config.request_delay_ms() if base_delay_ms is None else base_delay_ms
    origin = URL(url).origin
    rules = _rules_for(origin)
    crawl_s = rules.crawl_delay(config.USER_AGENT_TOKEN) if isinstance(rules, Rules) else 0
    delay = max(base, min(crawl_s * 1000, MAX_CRAWL_DELAY_MS))
    with _lock:
        wait = _last_request.get(origin, 0) * 1000 + delay - time.time() * 1000
    sleep_ms(wait)
    with _lock:
        _last_request[origin] = time.time()


def clear_robots_cache() -> None:
    with _lock:
        _cache.clear()
        _last_request.clear()

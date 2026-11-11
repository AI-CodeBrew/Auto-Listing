"""Pages and the URLs they contain are untrusted. Nothing they point to may reach this computer
or the local network, including this app's own API."""
from __future__ import annotations

import ipaddress
import socket
import threading
import time

import requests

from .. import config
from ..jsurl import URL, URLError

_BLOCKED_V4 = [ipaddress.ip_network(n) for n in (
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
    "192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/4", "240.0.0.0/4",
)]
_BLOCKED_V6 = [ipaddress.ip_network(n) for n in ("::/128", "::1/128", "fc00::/7", "fe80::/10", "ff00::/8")]


def is_private_address(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip.strip("[]"))
    except ValueError:
        return True
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    networks = _BLOCKED_V4 if isinstance(addr, ipaddress.IPv4Address) else _BLOCKED_V6
    return any(addr in network for network in networks)


def _is_ip(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False


_host_cache: dict[str, tuple[bool, float]] = {}
_cache_lock = threading.Lock()


def is_public_url(raw: str) -> bool:
    """True for an http(s) URL whose host resolves only to public addresses."""
    try:
        url = URL(raw)
    except URLError:
        return False
    if url.protocol not in ("http:", "https:"):
        return False
    if config.allow_private_network():
        return True
    host = url.hostname.strip("[]")
    with _cache_lock:
        cached = _host_cache.get(host)
    if cached and time.time() - cached[1] < 300:
        return cached[0]
    if _is_ip(host):
        ok = not is_private_address(host)
    else:
        try:
            addrs = {info[4][0] for info in socket.getaddrinfo(host, None)}
            ok = bool(addrs) and all(not is_private_address(a) for a in addrs)
        except OSError:
            ok = False
    with _cache_lock:
        _host_cache[host] = (ok, time.time())
    return ok


class FetchError(Exception):
    pass


class TooLargeError(Exception):
    pass


def safe_fetch(raw: str, *, method: str = "GET", headers: dict | None = None, timeout_ms: int = 30_000, **kwargs) -> tuple[requests.Response, str]:
    """A request that re-checks every redirect hop against the private-network rule. The body is streamed."""
    current = raw
    for _ in range(6):
        if not is_public_url(current):
            raise FetchError(f"Blocked address: {current}")
        merged = {"user-agent": config.USER_AGENT, **(headers or {})}
        try:
            response = requests.request(method, current, headers=merged, allow_redirects=False, stream=True, timeout=timeout_ms / 1000, **kwargs)
        except requests.RequestException as error:
            raise FetchError(str(error)) from error
        location = response.headers.get("location")
        if 300 <= response.status_code < 400 and location:
            response.close()
            current = URL(location, current).href
            continue
        return response, current
    raise FetchError(f"Too many redirects: {raw}")


def download_to_file(raw: str, dest: str, max_bytes: int, timeout_ms: int) -> dict:
    """Streams a URL to disk and stops as soon as the size limit is passed."""
    response, final_url = safe_fetch(raw, timeout_ms=timeout_ms)
    try:
        if not response.ok:
            raise FetchError(f"HTTP {response.status_code}")
        declared = int(response.headers.get("content-length") or 0)
        if declared > max_bytes:
            raise TooLargeError(f"File is {declared} bytes, over the {max_bytes} byte limit")
        size = 0
        with open(dest, "wb") as out:
            for chunk in response.iter_content(64 * 1024):
                size += len(chunk)
                if size > max_bytes:
                    raise TooLargeError(f"File is over the {max_bytes} byte limit")
                out.write(chunk)
        return {"bytes": size, "contentType": (response.headers.get("content-type") or "").lower(), "finalUrl": final_url}
    except requests.RequestException as error:
        raise FetchError(str(error)) from error
    finally:
        response.close()


def sleep_ms(ms: float) -> None:
    if ms > 0:
        time.sleep(ms / 1000)

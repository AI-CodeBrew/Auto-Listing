"""A small WHATWG-style URL helper, so URLs are parsed and printed the way the browser's
`new URL()` did in the old TypeScript code."""
from __future__ import annotations

from urllib.parse import parse_qsl, quote, unquote, urlencode, urlsplit, urlunsplit

DEFAULT_PORTS = {"http": 80, "https": 443}


class URLError(ValueError):
    pass


class URL:
    def __init__(self, raw: str, base: str | None = None):
        if base is not None:
            from urllib.parse import urljoin

            raw = urljoin(URL(base).href, raw.strip())
        raw = (raw or "").strip()
        try:
            parts = urlsplit(raw)
        except ValueError as error:
            raise URLError(str(error)) from error
        if not parts.scheme:
            raise URLError(f"Invalid URL: {raw}")
        self.scheme = parts.scheme.lower()
        special = self.scheme in ("http", "https", "ftp", "ws", "wss", "file")
        if special and self.scheme != "file" and not parts.netloc:
            raise URLError(f"Invalid URL: {raw}")
        try:
            host = parts.hostname or ""
            port = parts.port
        except ValueError as error:
            raise URLError(str(error)) from error
        if special and self.scheme != "file" and (not host or any(c in host for c in " <>\\^|")):
            raise URLError(f"Invalid URL: {raw}")
        self.username = parts.username or ""
        self.password = parts.password or ""
        try:
            self.hostname = host.encode("idna").decode("ascii").lower() if host and not host.startswith("[") and ":" not in host else host.lower()
        except UnicodeError:
            self.hostname = host.lower()
        self.port = "" if port is None or DEFAULT_PORTS.get(self.scheme) == port else str(port)
        path = parts.path
        if special and not path:
            path = "/"
        self.pathname = quote(path, safe="/%:@!$&'()*+,;=-._~")
        self._query = parts.query
        self.hash_value = parts.fragment
        self.special = special

    # --- read-only views ---
    @property
    def protocol(self) -> str:
        return f"{self.scheme}:"

    @property
    def host(self) -> str:
        return f"{self.hostname}:{self.port}" if self.port else self.hostname

    @property
    def origin(self) -> str:
        return f"{self.scheme}://{self.host}"

    @property
    def search(self) -> str:
        return f"?{self._query}" if self._query else ""

    @search.setter
    def search(self, value: str) -> None:
        self._query = value.lstrip("?")

    @property
    def hash(self) -> str:
        return f"#{self.hash_value}" if self.hash_value else ""

    @hash.setter
    def hash(self, value: str) -> None:
        self.hash_value = value.lstrip("#")

    # --- search params ---
    def params(self) -> list[tuple[str, str]]:
        return parse_qsl(self._query, keep_blank_values=True)

    def get_param(self, name: str) -> str | None:
        for key, value in self.params():
            if key == name:
                return value
        return None

    def set_params(self, pairs: list[tuple[str, str]]) -> None:
        self._query = urlencode(pairs, quote_via=quote, safe="")
        # URLSearchParams writes spaces as "+".
        self._query = self._query.replace("%20", "+")

    @property
    def href(self) -> str:
        auth = ""
        if self.username:
            auth = self.username + (f":{self.password}" if self.password else "") + "@"
        netloc = auth + self.host
        query = self._query
        if self.hash_value or query:
            pass
        return urlunsplit((self.scheme, netloc, self.pathname, query, self.hash_value)) if self.special or netloc else f"{self.scheme}:{self.pathname}{self.search}{self.hash}"

    def __str__(self) -> str:
        return self.href


def is_url(raw: str) -> bool:
    try:
        URL(raw)
        return True
    except URLError:
        return False


def encode_uri(text: str) -> str:
    """Same characters left alone as JavaScript's encodeURI."""
    return quote(text, safe=";,/?:@&=+$-_.!~*'()#")


def decode(text: str) -> str:
    return unquote(text)

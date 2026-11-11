"""Reduces untrusted HTML to plain text, and turns the description into safe Shopify HTML."""
from __future__ import annotations

import re
from html.parser import HTMLParser

NON_TEXT_TAGS = {"script", "style", "textarea", "noscript", "iframe", "object", "embed"}


class _TextOnly(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.out: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in NON_TEXT_TAGS:
            self.skip += 1

    def handle_endtag(self, tag):
        if tag in NON_TEXT_TAGS and self.skip:
            self.skip -= 1

    def handle_data(self, data):
        if not self.skip:
            self.out.append(data.replace("<", "&lt;").replace(">", "&gt;"))

    def handle_entityref(self, name):
        if not self.skip:
            self.out.append(f"&{name};")

    def handle_charref(self, name):
        if not self.skip:
            self.out.append(f"&#{name};")


def _strip_tags(text: str) -> str:
    parser = _TextOnly()
    parser.feed(text)
    parser.close()
    return "".join(parser.out)


def _decode_basic_entities(text: str) -> str:
    return (
        text.replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&#039;", "'")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
    )


def to_plain_text(value: str | None) -> str:
    if not value:
        return ""
    stripped = _strip_tags(value)
    text = _decode_basic_entities(stripped)
    text = re.sub(r"[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]", "", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def escape_html(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;").replace("'", "&#39;")


def description_to_html(description: str) -> str:
    """Lines starting with "- " or "* " become list items and the rest become paragraphs. All text is escaped."""
    out: list[str] = []
    bullets: list[str] = []

    def flush() -> None:
        if bullets:
            out.append("<ul>" + "".join(f"<li>{b}</li>" for b in bullets) + "</ul>")
            bullets.clear()

    for raw in re.split(r"\r?\n", description):
        line = raw.strip()
        if not line:
            flush()
            continue
        match = re.match(r"^[-*•]\s+(.*)$", line)
        if match:
            bullets.append(escape_html(match.group(1)))
        else:
            flush()
            out.append(f"<p>{escape_html(line)}</p>")
    flush()
    return "".join(out)

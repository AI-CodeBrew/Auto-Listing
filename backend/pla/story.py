"""The Saamano page text for one product. Written once by the AI, again only when the name or description changes."""
from __future__ import annotations

import hashlib

from .ai import write_product_story
from .settings import save_product_story, saved_product_story


def story_source(name: str, description: str) -> str:
    return hashlib.sha256(f"{name.strip()}\n{description.strip()}".encode()).hexdigest()


def _is_current(saved: dict | None, source: str) -> bool:
    # Text saved before a part existed is written again, so every product gets every part (Top Features too).
    return bool(
        saved and saved.get("source") == source and saved.get("featureCards") is not None
        and "compareIntro" in saved and saved.get("topFeatures") is not None
    )


def ensure_product_story(product_id: str, name: str, description: str, refresh: bool = False) -> dict:
    source = story_source(name, description)
    saved = saved_product_story(product_id)
    if not refresh and _is_current(saved, source):
        return {**saved, "fresh": False}
    story = write_product_story(name=name.strip(), description=description.strip())
    result = {"source": source, **story}
    save_product_story(product_id, result)
    return {**result, "fresh": True}


def current_product_story(product_id: str, name: str, description: str) -> dict | None:
    saved = saved_product_story(product_id)
    return saved if _is_current(saved, story_source(name, description)) else None

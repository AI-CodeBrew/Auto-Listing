"""Text rules applied to the AI draft: store names out, reviews out, risky claims marked."""
from __future__ import annotations

import re

RISKY_CLAIMS = [
    re.compile(r"\bBPA[- ]free\b", re.I),
    re.compile(r"\bmicrowave[- ]safe\b", re.I),
    re.compile(r"\bdishwasher[- ]safe\b", re.I),
    re.compile(r"\bfood[- ](safe|grade)\b", re.I),
    re.compile(r"\boven[- ]safe\b", re.I),
    re.compile(r"\bFDA[- ](approved|cleared|registered)\b", re.I),
    re.compile(r"\bCE[- ]certified\b", re.I),
    re.compile(r"\b(certified|hypoallergenic|non[- ]toxic|organic|lead[- ]free|phthalate[- ]free|waterproof|fireproof|antibacterial|clinically proven|eco[- ]friendly|biodegradable)\b", re.I),
]

NEEDS_CHECKING = "[needs checking]"

REVIEW_LANGUAGE = re.compile(
    r"(\b\d(\.\d)?\s*(/\s*5|out of 5|stars?)\b|\bstars?\s+rat|\brated\b|\bratings?\b|\breviews?\b|\btestimonials?\b|\bcustomers? (love|say|rave)\b|\bbest[- ]?sell(er|ing)\b|★)",
    re.I,
)

WORD = re.compile(r"[^\W_]+")


def words_of(text: str) -> list[str]:
    return WORD.findall(text.lower())


def find_copied_phrases(text: str, sources: list[str], run_length: int = 8) -> list[str]:
    """Runs of at least `run_length` consecutive words shared with a source."""
    words = words_of(text)
    if len(words) < run_length:
        return []
    grams: set[str] = set()
    for source in sources:
        sw = words_of(source)
        for i in range(0, len(sw) - run_length + 1):
            grams.add(" ".join(sw[i : i + run_length]))
    phrases: list[str] = []
    i = 0
    while i + run_length <= len(words):
        if " ".join(words[i : i + run_length]) in grams:
            end = i + run_length
            while end < len(words) and " ".join(words[end - run_length + 1 : end + 1]) in grams:
                end += 1
            phrases.append(" ".join(words[i:end]))
            i = end
            continue
        i += 1
    return phrases


def remove_store_words(name: str, sellers: list[str]) -> str:
    result = name
    for seller in sellers:
        clean = (seller or "").strip()
        if len(clean) < 3:
            continue
        pattern = re.compile(r"(^|[\s|\-–—:(,])" + re.escape(clean) + r"(?=$|[\s|\-–—:),])", re.I)
        result = pattern.sub(r"\1", result)
    result = re.sub(r"\s*[|\-–—:]\s*$", "", result)
    result = re.sub(r"^\s*[|\-–—:]\s*", "", result)
    result = re.sub(r"\(\s*\)", "", result)
    result = re.sub(r"\s{2,}", " ", result)
    return result.strip()


def drop_review_sentences(text: str) -> str:
    sentences = re.split(r"(?<=[.!?])\s+", text)
    return " ".join(s for s in sentences if not REVIEW_LANGUAGE.search(s)).strip()


def mark_claims(text: str, claims: list[str]) -> str:
    result = text
    for claim in sorted(claims, key=len, reverse=True):
        escaped = re.escape(claim.strip())
        if not claim.strip():
            continue
        pattern = re.compile(r"(?<![^\W_])" + escaped + r"(?![^\W_])(?!\s*\[needs checking\])", re.I)
        result = pattern.sub(lambda m: f"{m.group(0)} {NEEDS_CHECKING}", result)
    return result


def detect_risky_claims(text: str) -> list[str]:
    found: dict[str, str] = {}
    for pattern in RISKY_CLAIMS:
        for match in pattern.finditer(text):
            found[match.group(0).lower()] = match.group(0)
    return list(found.values())


def _unique_by_lower(items: list[str]) -> list[str]:
    seen: dict[str, str] = {}
    for item in items:
        seen[item.lower()] = item
    return list(seen.values())


def finalize_listing(draft: dict, sellers: list[str], fallback_name: str) -> dict:
    name = remove_store_words(draft["best_name"], sellers) or fallback_name
    options: list[str] = []
    for option in draft.get("name_options", []):
        cleaned = remove_store_words(option, sellers)
        if cleaned and cleaned not in options:
            options.append(cleaned)
    name_options = [o for o in options if o.lower() != name.lower()]
    paragraph = drop_review_sentences(draft.get("description", ""))
    bullets = [re.sub(r"^[-*•]\s*", "", b).strip() for b in draft.get("feature_bullets", [])]
    bullets = [b for b in bullets if b and not REVIEW_LANGUAGE.search(b)]
    plain = "\n".join([paragraph, *bullets])
    claims = _unique_by_lower([c.strip() for c in draft.get("claims_needing_check", []) if c.strip()] + detect_risky_claims(plain))
    description = "\n".join([mark_claims(paragraph, claims), "", *[f"- {mark_claims(b, claims)}" for b in bullets]]).strip()
    category = re.sub(r"\s+", " ", remove_store_words(draft.get("category") or "", sellers)).strip()[:60]
    return {"name": name, "nameOptions": name_options, "category": category, "description": description, "claims": claims}


def choose_best_images(images: list[dict], limit: int) -> list[str]:
    """Ranks passing images and returns the IDs to preselect. The user's own upload comes first."""
    passing = [image for image in images if image["passed"]]

    def key(image: dict):
        area = (image.get("width") or 0) * (image.get("height") or 0)
        return (0 if image["uploaded"] else 1, -(image["checks"].get("quality") or 0), -area)

    return [image["id"] for image in sorted(passing, key=key)[:limit]]

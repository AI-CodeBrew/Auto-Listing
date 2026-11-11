"""Published unit prices used to estimate a request. SerpAPI searches are counted, not priced.
OpenAI gpt-6-luna: $0.10 per million input tokens, $0.50 per million output tokens.
FastMoss bills in credits, counted but not added into the dollar total."""
from __future__ import annotations

import math

RATES = {"serpapiUsd": 0, "aiInputPerMillion": 0.1, "aiOutputPerMillion": 0.5}
EMPTY_USAGE = {"serpapi": 0, "fastmoss": 0, "aiInput": 0, "aiOutput": 0}


def normalize_usage(value: dict | None) -> dict:
    def num(item):
        return item if isinstance(item, (int, float)) and not isinstance(item, bool) and math.isfinite(item) else 0

    value = value or {}
    return {key: num(value.get(key)) for key in EMPTY_USAGE}


def price_usage(usage: dict) -> dict:
    ai_usd = (usage["aiInput"] / 1_000_000) * RATES["aiInputPerMillion"] + (usage["aiOutput"] / 1_000_000) * RATES["aiOutputPerMillion"]
    return {"serpapiUsd": 0, "aiUsd": ai_usd, "fastmossCredits": usage["fastmoss"], "totalUsd": ai_usd}


def money(amount: float) -> str:
    sign = "-" if amount < 0 else ""
    return f"{sign}${abs(amount):.4f}"

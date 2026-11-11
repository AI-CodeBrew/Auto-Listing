"""All environment access lives here. Values are read at call time so tests can point the
app at local mock servers.

The *_OVERRIDE / ALLOW_PRIVATE_NETWORK variables are for the automated tests only.
"""
from __future__ import annotations

import os
from urllib.parse import urlparse


def env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or "").strip() or default


# The backend folder. The database (data/) and the images and videos (storage/) live in it.
BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _root() -> str:
    # A relative APP_DATA_DIR or APP_STORAGE_DIR is resolved from APP_ROOT (the project folder).
    return os.path.abspath(os.environ.get("APP_ROOT") or os.getcwd())


def _resolve(path: str) -> str:
    return path if os.path.isabs(path) else os.path.abspath(os.path.join(_root(), path))


def data_dir() -> str:
    return _resolve(os.environ.get("APP_DATA_DIR") or ("/tmp/pla-data" if os.environ.get("VERCEL") else os.path.join(BACKEND_DIR, "data")))


def storage_dir() -> str:
    return _resolve(os.environ.get("APP_STORAGE_DIR") or ("/tmp/pla-storage" if os.environ.get("VERCEL") else os.path.join(BACKEND_DIR, "storage")))


def database_url() -> str:
    return env("DATABASE_URL")


def ai_provider() -> str:
    chosen = env("AI_PROVIDER").lower()
    if chosen in ("openai", "claude"):
        return chosen
    return "openai" if env("OPENAI_API_KEY") and not env("AI_API_KEY") else "claude"


def openai_api_key() -> str:
    return env("OPENAI_API_KEY")


def openai_model() -> str:
    return env("OPENAI_MODEL", "gpt-6-luna")


def youtube_api_key() -> str:
    return env("YOUTUBE_API_KEY")


def meta_access_token() -> str:
    return env("META_ACCESS_TOKEN")


def meta_app_id() -> str:
    return env("META_APP_ID")


def meta_app_secret() -> str:
    return env("META_APP_SECRET")


def openai_base_url() -> str:
    return env("OPENAI_BASE_URL_OVERRIDE", "https://api.openai.com").rstrip("/")


def ai_api_key() -> str:
    return env("AI_API_KEY")


def ai_model() -> str:
    return env("AI_MODEL", "claude-sonnet-5-5")


def ai_base_url() -> str:
    return env("AI_BASE_URL_OVERRIDE", "https://api.anthropic.com").rstrip("/")


def shopify_api_version() -> str:
    return env("SHOPIFY_API_VERSION", "2026-10")


def shopify_base_url_override() -> str:
    return env("SHOPIFY_BASE_URL_OVERRIDE")


def serp_api_keys() -> tuple[str, str]:
    return (env("SERPAPI_KEY") or env("SERPAPI_API_KEY"), env("SERPAPI_API_KEY_2"))


def serp_api_key() -> str:
    first, second = serp_api_keys()
    return first or second


def serp_api_base_url() -> str:
    return env("SERPAPI_BASE_URL_OVERRIDE", "https://serpapi.com").rstrip("/")


def fastmoss_mcp_url() -> str:
    return env("FASTMOSS_MCP_URL_OVERRIDE", "https://mcp.fastmoss.com/mcp").rstrip("/")


def public_base_url() -> str:
    raw = env("PUBLIC_BASE_URL")
    if not raw:
        return ""
    try:
        url = urlparse(raw)
    except ValueError:
        return ""
    if url.scheme not in ("http", "https") or not url.netloc:
        return ""
    return f"{url.scheme}://{url.netloc}"


def bing_base_url() -> str:
    return env("BING_BASE_URL_OVERRIDE", "https://www.bing.com")


def request_delay_ms() -> int:
    try:
        return int(float(os.environ.get("REQUEST_DELAY_MS") or 1500))
    except ValueError:
        return 1500


def allow_private_network() -> bool:
    return os.environ.get("ALLOW_PRIVATE_NETWORK") == "1"


def on_vercel() -> bool:
    return bool(os.environ.get("VERCEL"))


class LIMITS:
    page_timeout_ms = 30_000
    pages_per_try = 8
    extra_search_tries = 3
    target_images = 5
    max_preselected_images = 10
    image_max_bytes = 20 * 1024 * 1024
    upload_images = 20
    video_max_bytes = 1024 * 1024 * 1024
    image_min_side = 800
    icon_max_side = 200
    images_per_page = 12
    max_video_downloads = 5
    source_text_chars = 12_000
    job_max_attempts = 3


def ai_limits() -> dict:
    return {
        "maxImagesToAiCheck": 30,
        "stopCheckingAfterPasses": 15,
        "framesPerVideo": 4,
        "visionMaxSide": 1280,
        "maxReferenceImages": 3,
    }


USER_AGENT_TOKEN = "ProductListingAssistant"
USER_AGENT = f"{USER_AGENT_TOKEN}/1.0"

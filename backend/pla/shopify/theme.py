"""Adds a product page template to the store's live theme. Only new "fynk-" files are written, so
nothing already in the theme changes."""
from __future__ import annotations

import re
import threading
import time
from datetime import datetime, timezone
from urllib.parse import quote

from ..settings import pin_active_store, save_template_push, shopify_credentials
from ..templates import read_template_files
from .client import ShopifyError, graphql, missing_shopify_settings

FILES_PER_UPLOAD = 50
BYTES_PER_UPLOAD = 1_000_000
POLL_S = 2
JOBS_TIMEOUT_S = 90
RETRY_ROUNDS = 2
OWN_FILE = re.compile(r"^(assets|sections|snippets|blocks)/fynk-|^templates/[a-z_]+\.fynk-")

SCOPES = """query ThemeScopes {
  currentAppInstallation { accessScopes { handle } }
}"""
LIVE_THEME = """query ThemeLive {
  themes(first: 1, roles: [MAIN]) { nodes { id name } }
}"""
SAMPLE_PRODUCT = """query ThemeSampleProduct {
  products(first: 1, query: "status:active") { nodes { handle } }
}"""
UPSERT = """mutation UpsertThemeFiles($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
  themeFilesUpsert(themeId: $themeId, files: $files) {
    upsertedThemeFiles { filename }
    job { id }
    userErrors { filename code message }
  }
}"""
JOB = """query JobStatus($id: ID!) {
  job(id: $id) { id done }
}"""


def upload_phase(filename: str) -> int:
    if filename.startswith(("assets/", "snippets/", "locales/")):
        return 0
    if filename.startswith("blocks/"):
        return 1
    if filename.startswith("sections/") and filename.endswith(".liquid"):
        return 2
    if filename.startswith("sections/"):
        return 3
    if filename.startswith("layout/"):
        return 4
    if filename == "config/settings_schema.json":
        return 5
    if filename.startswith("config/"):
        return 6
    return 7


def upload_batches(files: list[dict]) -> list[list[dict]]:
    phases: dict[int, list[dict]] = {}
    for file in files:
        phases.setdefault(upload_phase(file["filename"]), []).append(file)
    batches: list[list[dict]] = []
    for phase in sorted(phases):
        current: list[dict] = []
        size = 0
        for file in phases[phase]:
            if current and (len(current) >= FILES_PER_UPLOAD or size + len(file["value"]) > BYTES_PER_UPLOAD):
                batches.append(current)
                current, size = [], 0
            current.append(file)
            size += len(file["value"])
        if current:
            batches.append(current)
    return batches


_running = threading.Lock()


def is_theme_push_running() -> bool:
    return _running.locked()


def _numeric_id(gid: str) -> str:
    return gid.split("/")[-1] or gid


def _scope_help() -> str:
    if shopify_credentials()["method"] == "token":
        return "Fix: in the Shopify admin open Apps → Develop apps → your app → Configuration, add read_themes and write_themes to the Admin API scopes, save, install the app again, and push again."
    return "Fix: in the Shopify Dev Dashboard open your app, make a new version with the scopes read_themes and write_themes added, release it, approve the update on your store (Settings → Apps and sales channels), then push again."


def push_theme_template(template: dict, on_progress=lambda step: None) -> dict:
    if not _running.acquire(blocking=False):
        raise ShopifyError("A theme push is already running. Wait for it to finish.")
    try:
        pin_active_store()
        return _push(template, on_progress)
    finally:
        _running.release()


def _push(template: dict, on_progress) -> dict:
    missing = missing_shopify_settings()
    if missing:
        raise ShopifyError(f"Connect Shopify first. Fill in on the Integrations page: {', '.join(missing)}.")
    domain = shopify_credentials()["domain"]

    on_progress("Checking the app's permissions...")
    installed = graphql(SCOPES, {}, 30_000)
    granted = {scope["handle"] for scope in installed["currentAppInstallation"]["accessScopes"]}
    lacking = ([] if "write_themes" in granted else ["write_themes"]) + ([] if ("read_themes" in granted or "write_themes" in granted) else ["read_themes"])
    if lacking:
        plural = "s" if len(lacking) > 1 else ""
        raise ShopifyError(f"The app is missing the {' and '.join(lacking)} permission{plural}, so it cannot add the product page to your theme. {_scope_help()} Nothing in your store was changed.")

    on_progress("Finding your live theme...")
    themes = graphql(LIVE_THEME, {}, 30_000)
    nodes = themes["themes"]["nodes"]
    if not nodes:
        raise ShopifyError("This store has no live theme. Publish a theme in Online Store → Themes, then push again.")
    live = nodes[0]
    try:
        sample = graphql(SAMPLE_PRODUCT, {}, 30_000)
    except Exception:  # noqa: BLE001 - only used for the preview link
        sample = None
    products = (sample or {}).get("products") or {"nodes": []}

    on_progress(f"Reading the {template['name']} files...")
    files = read_template_files(template["id"])
    foreign = [f for f in files if not OWN_FILE.search(f["filename"])]
    if foreign:
        raise ShopifyError(f"These files could replace the store's own and were not sent: {', '.join(f['filename'] for f in foreign)}.")

    on_progress(f'Adding {len(files)} new files to your live theme "{live["name"]}". Nothing already in it changes...')
    failed, jobs = _upload_all(live["id"], files, on_progress)
    if failed:
        raise ShopifyError(f"Shopify refused {', '.join(f'{name} ({msg})' for name, msg in failed.items())}. The rest of your store was not changed.")
    if jobs:
        on_progress("Waiting for Shopify to save the files...")
        _wait_for_jobs(jobs)

    handle = products["nodes"][0]["handle"] if products["nodes"] else None
    view = f"view={quote(template['templateSuffix'], safe='')}"
    saved = {
        "domain": domain,
        "themeId": live["id"],
        "themeName": live["name"],
        "previewUrl": f"https://{domain}/",
        "productPreviewUrl": f"https://{domain}/products/{quote(handle, safe='')}?{view}" if handle else None,
        "editorUrl": f"https://{domain}/admin/themes/{_numeric_id(live['id'])}/editor",
        "at": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    }
    save_template_push(template["id"], saved)
    return {**saved, "uploaded": len(files), "unchanged": 0, "removed": 0, "warnings": []}


def _upload_all(theme_id: str, files: list[dict], on_progress) -> tuple[dict, list[str]]:
    jobs: list[str] = []
    pending = files
    failed: dict[str, str] = {}
    for round_index in range(RETRY_ROUNDS + 1):
        if not pending:
            break
        failed = {}
        for batch in upload_batches(pending):
            if round_index > 0:
                on_progress(f"Trying {len(pending)} refused file{'' if len(pending) == 1 else 's'} again...")
            data = graphql(UPSERT, {
                "themeId": theme_id,
                "files": [{"filename": f["filename"], "body": {"type": f["type"], "value": f["value"]}} for f in batch],
            })
            result = data["themeFilesUpsert"]
            if result.get("job"):
                jobs.append(result["job"]["id"])
            for error in result.get("userErrors") or []:
                names = [error["filename"]] if error.get("filename") else [f["filename"] for f in batch]
                for name in names:
                    failed[name] = error["message"]
        pending = [f for f in files if f["filename"] in failed]
    return failed, jobs


def _wait_for_jobs(ids: list[str]) -> None:
    deadline = time.time() + JOBS_TIMEOUT_S
    still_open = list(dict.fromkeys(ids))
    while still_open:
        nxt = []
        for job_id in still_open:
            data = graphql(JOB, {"id": job_id}, 30_000)
            if data.get("job") and not data["job"]["done"]:
                nxt.append(job_id)
        still_open = nxt
        if not still_open or time.time() > deadline:
            return
        time.sleep(POLL_S)

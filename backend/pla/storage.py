"""File storage. Layout: storage/<productId>/images/<file> and storage/<productId>/videos/<file>."""
from __future__ import annotations

import os
import re
import uuid

from . import bunny, config

SAFE_ID = re.compile(r"^[a-zA-Z0-9-]+$")
SAFE_FILE = re.compile(r"^[a-zA-Z0-9._-]+$")


def is_safe_kind(kind: str) -> bool:
    return kind in ("images", "videos")


def media_path(product_id: str, kind: str, file_name: str) -> str:
    if not SAFE_ID.match(product_id or "") or not SAFE_FILE.match(file_name or "") or file_name.startswith("."):
        raise ValueError("Invalid storage path")
    return os.path.join(config.storage_dir(), product_id, kind, file_name)


def ensure_dirs(product_id: str) -> None:
    for kind in ("images", "videos"):
        os.makedirs(os.path.dirname(media_path(product_id, kind, "x")), exist_ok=True)


def temp_path(product_id: str, kind: str) -> str:
    ensure_dirs(product_id)
    return media_path(product_id, kind, f"tmp-{uuid.uuid4()}.part")


def commit_file(product_id: str, kind: str, tmp: str, ext: str) -> str:
    file_name = f"{uuid.uuid4()}.{re.sub(r'[^a-z0-9]', '', ext, flags=re.I).lower()}"
    os.replace(tmp, media_path(product_id, kind, file_name))
    return file_name


def remove_quietly(file: str) -> None:
    try:
        os.remove(file)
    except OSError:
        # Windows can hold a brief lock on a file that was just read. A leftover file is harmless.
        pass


def clear_research_files(product_id: str, keep: list[str]) -> None:
    for kind in ("images", "videos"):
        folder = os.path.dirname(media_path(product_id, kind, "x"))
        if os.path.isdir(folder):
            for name in os.listdir(folder):
                if name not in keep:
                    remove_quietly(os.path.join(folder, name))
        if bunny.enabled():
            for name in bunny.list_files(f"{product_id}/{kind}"):
                if name not in keep:
                    bunny.delete(bunny.remote_path(product_id, kind, name))


# ---------- Bunny Storage (see bunny.py). Without it, these do nothing and files stay local. ----------

def _finished_files(product_id: str):
    for kind in ("images", "videos"):
        folder = os.path.dirname(media_path(product_id, kind, "x"))
        if not os.path.isdir(folder):
            continue
        for name in os.listdir(folder):
            if SAFE_FILE.match(name) and not name.startswith("tmp-") and not name.endswith(".part"):
                yield kind, name, os.path.join(folder, name)


def publish_files(product_id: str) -> None:
    """Moves a product's finished files to Bunny, then deletes the local copies, so the server's own
    disk holds nothing between jobs. Runs after uploads and at the end of each research job."""
    if not bunny.enabled():
        return
    for kind, name, file in _finished_files(product_id):
        bunny.upload(file, bunny.remote_path(product_id, kind, name))
        remove_quietly(file)


def ensure_local(product_id: str, kind: str, file_name: str) -> str:
    """The file's local path, copied back from Bunny first when it is only there."""
    file = media_path(product_id, kind, file_name)
    if not os.path.exists(file) and bunny.enabled():
        ensure_dirs(product_id)
        bunny.download(bunny.remote_path(product_id, kind, file_name), file)
    return file


def fetch_inputs(product: dict) -> None:
    """Brings the user's own uploads back to the local disk before research reads them."""
    for name in [product.get("input_image"), *(product.get("input_images") or [])]:
        if name:
            ensure_local(product["id"], "images", name)
    if product.get("input_video"):
        ensure_local(product["id"], "videos", product["input_video"])


def public_url(product_id: str, kind: str, file_name: str) -> str | None:
    """The file's CDN address when files are on Bunny."""
    media_path(product_id, kind, file_name)  # the same name checks as local files
    return bunny.public_url(bunny.remote_path(product_id, kind, file_name)) if bunny.enabled() else None

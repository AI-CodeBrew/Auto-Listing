"""Product photos and videos in Bunny Storage, shown through its CDN (a Bunny Pull Zone).

Used only when all four settings are filled in (backend/.env, or Fly secrets):
  BUNNY_STORAGE_ZONE   the storage zone's name
  BUNNY_STORAGE_KEY    the zone's password (Storage zone > FTP & API Access)
  BUNNY_STORAGE_HOST   the zone's region host, for example sg.storage.bunnycdn.com
  BUNNY_CDN_URL        the pull zone's address, for example https://autolisting-media.b-cdn.net
Otherwise every file stays on the local disk, as before.

Files are stored as <productId>/<images|videos>/<file>, the same layout as the local storage folder.
"""
from __future__ import annotations

import os
from urllib.parse import quote

import httpx

from . import config

# The longest wait with no progress, not the whole transfer, so a large video still finishes.
TIMEOUT = httpx.Timeout(connect=30, write=120, read=300, pool=30)


class BunnyError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def _settings() -> dict | None:
    zone = config.env("BUNNY_STORAGE_ZONE")
    key = config.env("BUNNY_STORAGE_KEY")
    host = config.env("BUNNY_STORAGE_HOST")
    cdn = config.env("BUNNY_CDN_URL")
    if not (zone and key and host and cdn):
        return None
    base = host if host.startswith(("http://", "https://")) else f"https://{host}"
    return {"zone": zone, "key": key, "base": base.rstrip("/"), "cdn": cdn.rstrip("/")}


def enabled() -> bool:
    return _settings() is not None


def remote_path(product_id: str, kind: str, name: str) -> str:
    return f"{product_id}/{kind}/{name}"


def _url(settings: dict, path: str) -> str:
    return f"{settings['base']}/{quote(settings['zone'])}/{quote(path)}"


def _need() -> dict:
    settings = _settings()
    if not settings:
        raise BunnyError("Bunny Storage is not set up.")
    return settings


def public_url(path: str) -> str:
    return f"{_need()['cdn']}/{quote(path)}"


def upload(local_file: str, path: str) -> None:
    settings = _need()
    size = os.path.getsize(local_file)
    try:
        with open(local_file, "rb") as handle:
            response = httpx.put(
                _url(settings, path),
                content=handle,
                headers={"AccessKey": settings["key"], "Content-Type": "application/octet-stream", "Content-Length": str(size)},
                timeout=TIMEOUT,
            )
    except httpx.HTTPError as error:
        raise BunnyError(f"Saving {os.path.basename(path)} to Bunny failed: {error}") from error
    if response.status_code not in (200, 201):
        raise BunnyError(f"Bunny refused {os.path.basename(path)} (HTTP {response.status_code}). Check the BUNNY_* settings.", response.status_code)


def download(path: str, local_file: str) -> bool:
    """Copies a stored file to the local disk. False when Bunny does not have it."""
    settings = _need()
    tmp = f"{local_file}.part"
    try:
        with httpx.stream("GET", _url(settings, path), headers={"AccessKey": settings["key"]}, timeout=TIMEOUT) as response:
            if response.status_code == 404:
                return False
            if response.status_code != 200:
                raise BunnyError(f"Bunny could not give back {os.path.basename(path)} (HTTP {response.status_code}).")
            with open(tmp, "wb") as out:
                for chunk in response.iter_bytes():
                    out.write(chunk)
        os.replace(tmp, local_file)
        return True
    except httpx.HTTPError as error:
        raise BunnyError(f"Reading {os.path.basename(path)} from Bunny failed: {error}") from error
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def delete(path: str) -> None:
    settings = _need()
    try:
        response = httpx.delete(_url(settings, path), headers={"AccessKey": settings["key"]}, timeout=TIMEOUT)
    except httpx.HTTPError as error:
        raise BunnyError(f"Deleting {os.path.basename(path)} from Bunny failed: {error}") from error
    if response.status_code not in (200, 404):
        raise BunnyError(f"Bunny could not delete {os.path.basename(path)} (HTTP {response.status_code}).")


def list_files(folder: str) -> list[str]:
    """File names directly in a folder (no sub-folders). Empty when the folder does not exist."""
    settings = _need()
    try:
        response = httpx.get(_url(settings, folder.rstrip("/")) + "/", headers={"AccessKey": settings["key"], "Accept": "application/json"}, timeout=TIMEOUT)
    except httpx.HTTPError as error:
        raise BunnyError(f"Listing {folder} on Bunny failed: {error}") from error
    if response.status_code == 404:
        return []
    if response.status_code != 200:
        raise BunnyError(f"Bunny could not list {folder} (HTTP {response.status_code}).", response.status_code)
    return [item["ObjectName"] for item in response.json() if not item.get("IsDirectory")]

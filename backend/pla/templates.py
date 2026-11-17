"""Designs kept in frontend/theme-templates/<folder>.

A product page design (THEME_TEMPLATES) adds its files to the store's live theme as an alternate product
template. Nothing already in the theme changes.

An entire store design (STORE_TEMPLATES) also gives the store its home page, collection page and collection
list. It never replaces the product page the store already has."""
from __future__ import annotations

import base64
import hashlib
import os
import re

THEME_TEMPLATES = [
    {
        "id": "saamano",
        "name": "Bundle product page",
        "folder": "fynk-autolisting-product",
        "templateSuffix": "fynk-autolisting-product",
        "tagline": "Bundle cards and AI-written features",
        "preview": "/template-preview/saamano.jpg",
        "afterPush": "New products you push now use this page. Products already in your store keep theirs.",
    },
    {
        "id": "classic",
        "name": "Classic product page",
        "folder": "fynk-classic-product",
        "templateSuffix": "fynk-classic-product",
        "tagline": "Serif headlines on a calm cream layout",
        "preview": "/template-preview/classic.jpg",
        "afterPush": "New products you push now use this page. Products already in your store keep theirs.",
    },
]

STORE_TEMPLATES = [
    {
        "id": "simmer",
        "kind": "store",
        "name": "Simmer store",
        "folder": "fynk-simmer-store",
        "templateSuffix": "fynk-simmer",
        "tagline": "A warm, bright store with a mega menu, deal timer and lookbook",
        "preview": "/template-preview/simmer.jpg",
        "previewPage": "/template-preview/simmer.html",
        # Files of the live theme the design takes over. Everything else it adds is new.
        "replaces": ["templates/index.json", "templates/collection.json", "templates/list-collections.json"],
        "afterPush": "Your home page, collection pages, header and footer now use this design. Your product page is unchanged.",
    },
]

THEME_FOLDERS = ["assets", "blocks", "config", "layout", "locales", "sections", "snippets", "templates"]
BINARY = re.compile(r"\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|pdf)$", re.I)


def find_template(template_id: str) -> dict | None:
    return next((t for t in THEME_TEMPLATES if t["id"] == template_id), None)


def find_store_template(template_id: str) -> dict | None:
    return next((t for t in STORE_TEMPLATES if t["id"] == template_id), None)


def templates_root() -> str:
    """theme-templates lives in frontend/ (frontend/theme-templates in the project folder, APP_ROOT)."""
    root = os.environ.get("THEME_TEMPLATES_DIR")
    if root:
        return os.path.abspath(root)
    return os.path.join(os.path.abspath(os.environ.get("APP_ROOT") or os.getcwd()), "frontend", "theme-templates")


def _template_dir(template_id: str) -> str:
    template = find_template(template_id) or find_store_template(template_id)
    return os.path.join(templates_root(), template["folder"] if template else template_id)


def _list_files(folder: str) -> list[str]:
    out = []
    for entry in sorted(os.scandir(folder), key=lambda e: e.name):
        if entry.name.startswith("."):
            continue
        if entry.is_dir():
            out.extend(_list_files(entry.path))
        elif entry.is_file():
            out.append(entry.path)
    return out


def read_template_files(template_id: str) -> list[dict]:
    template = find_template(template_id) or find_store_template(template_id)
    if not template:
        raise ValueError(f'Unknown template "{template_id}".')
    root = _template_dir(template_id)
    files = []
    for folder in THEME_FOLDERS:
        path = os.path.join(root, folder)
        if not os.path.isdir(path):
            continue
        for full in _list_files(path):
            with open(full, "rb") as handle:
                raw = handle.read()
            filename = os.path.relpath(full, root).replace(os.sep, "/")
            binary = bool(BINARY.search(filename))
            files.append({
                "filename": filename,
                "type": "BASE64" if binary else "TEXT",
                "value": base64.b64encode(raw).decode() if binary else raw.decode("utf-8"),
                "md5": hashlib.md5(raw).hexdigest(),
                "bytes": len(raw),
            })
    wanted = [f"templates/product.{template['templateSuffix']}.json"]
    if template.get("kind") == "store":
        wanted += template["replaces"]
    for name in wanted:
        if not any(f["filename"] == name for f in files):
            raise ValueError(f"The {template_id} template is missing {name}.")
    return sorted(files, key=lambda f: f["filename"])


def template_size(template_id: str) -> dict:
    files = read_template_files(template_id)
    return {"files": len(files), "bytes": sum(f["bytes"] for f in files)}


def read_store_content(template_id: str) -> dict:
    """The sample text and pictures a store design shows before the store has its own. A push saves it as
    the shop metafield fynk.store_generation, which the design's sections read."""
    path = os.path.join(_template_dir(template_id), "store-content.json")
    with open(path, encoding="utf-8") as handle:
        import json

        return json.load(handle)

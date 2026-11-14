"""Creates (or updates) a DRAFT product in Shopify from an approved listing."""
from __future__ import annotations

import contextvars
import os
import re
import threading
import time
import traceback
import unicodedata

import httpx

from .. import repo
from ..sanitize import description_to_html
from .. import settings
from ..settings import shopify_credentials
from ..storage import ensure_local, public_url
from ..story import current_product_story, ensure_product_story
from ..templates import find_template
from .client import ShopifyError, graphql, missing_shopify_settings



def new_product_template_suffix() -> str:
    """The page a new product gets: the one chosen for this store on the Template page (Bundle until one is chosen)."""
    template = find_template(settings.default_template_id()) or find_template(settings.DEFAULT_TEMPLATE_ID)
    return template["templateSuffix"]

FIND_BY_HANDLE = """
  query FindDraftByHandle($identifier: ProductIdentifierInput!) {
    productByIdentifier(identifier: $identifier) {
      id
      status
    }
  }
"""

STAGED_UPLOADS = """
  mutation StagedUploads($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters {
          name
          value
        }
      }
      userErrors {
        field
        message
      }
    }
  }
"""

PRODUCT_SET = """
  mutation CreateDraftProduct($input: ProductSetInput!, $synchronous: Boolean!) {
    productSet(input: $input, synchronous: $synchronous) {
      product {
        id
        status
        handle
      }
      userErrors {
        code
        field
        message
      }
    }
  }
"""

MEDIA_STATUS = """
  query DraftMediaStatus($id: ID!) {
    product(id: $id) {
      media(first: 50) {
        nodes {
          id
          status
          mediaContentType
          mediaErrors {
            code
            message
          }
        }
      }
    }
  }
"""

# Each limit is the longest wait with NO progress (one chunk sent or received), not the whole upload,
# so a slow but moving upload of a 1 GB video still finishes. A stalled connection fails in minutes
# with a clear error instead of leaving the product on "Sending..." for an hour.
UPLOAD_TIMEOUT = httpx.Timeout(connect=30, write=120, read=300, pool=30)

MIME_BY_EXT = {
    "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp", "gif": "image/gif",
    "mp4": "video/mp4", "mov": "video/quicktime", "webm": "video/webm",
}


def _local_file(product_id: str, kind: str, file_name: str) -> dict:
    file = ensure_local(product_id, kind, file_name)
    ext = os.path.splitext(file_name)[1][1:].lower()
    mime = MIME_BY_EXT.get(ext)
    if not mime:
        raise ShopifyError(f"Unsupported file type: {file_name}")
    if not os.path.exists(file):
        raise ShopifyError(f"A selected file is missing from storage: {file_name}")
    return {"file": file, "fileName": file_name, "mimeType": mime, "size": os.path.getsize(file), "resource": "IMAGE" if kind == "images" else "VIDEO"}


def _upload_files(files: list[dict]) -> list[str]:
    if not files:
        return []
    data = graphql(STAGED_UPLOADS, {
        "input": [
            {"filename": f["fileName"], "mimeType": f["mimeType"], "resource": f["resource"], "httpMethod": "POST", "fileSize": str(f["size"])}
            for f in files
        ],
    })
    targets = data["stagedUploadsCreate"]["stagedTargets"]
    errors = data["stagedUploadsCreate"]["userErrors"]
    if errors:
        raise ShopifyError("Shopify rejected the upload request: " + "; ".join(e["message"] for e in errors))
    urls = []
    for index, item in enumerate(files):
        target = targets[index] if index < len(targets) else None
        if not target or not target.get("url") or not target.get("resourceUrl"):
            raise ShopifyError(f"Shopify gave no upload target for {item['fileName']}")
        fields = {p["name"]: p["value"] for p in target["parameters"]}
        # The file field must come last. httpx streams it from disk, so a 1 GB video is not loaded into memory.
        try:
            with open(item["file"], "rb") as handle:
                response = httpx.post(target["url"], data=fields, files={"file": (item["fileName"], handle, item["mimeType"])}, timeout=UPLOAD_TIMEOUT)
        except httpx.TimeoutException as error:
            raise ShopifyError(
                f"Upload of {item['fileName']} stopped: the internet connection sent nothing for a while. "
                "Check the connection and click Retry. It checks Shopify first, so it will not create a duplicate."
            ) from error
        except httpx.HTTPError as error:
            raise ShopifyError(f"Upload of {item['fileName']} failed: {error}") from error
        if response.status_code >= 400:
            raise ShopifyError(f"Upload of {item['fileName']} failed (HTTP {response.status_code}): {response.text[:200]}")
        urls.append(target["resourceUrl"])
    return urls


def _admin_url(gid: str) -> str:
    return f"https://{shopify_credentials()['domain']}/admin/products/{gid.split('/')[-1]}"


def make_handle(product: dict) -> str:
    """A stable handle is what lets Retry find a product whose creation response was lost."""
    slug = unicodedata.normalize("NFKD", (product.get("name") or "product").lower())
    slug = "".join(c for c in slug if not unicodedata.category(c).startswith("M"))
    slug = re.sub(r"[^a-z0-9]+", "-", slug)
    slug = re.sub(r"^-+|-+$", "", slug)[:60]
    slug = re.sub(r"-+$", "", slug)
    sku = re.sub(r"[^a-z0-9-]", "", (product.get("sku") or "").lower())
    return "-".join(p for p in (slug or "product", sku, product["id"][:8]) if p)


def _line(value: str) -> str:
    return re.sub(r"\s+", " ", value.replace("|", "/")).strip()


def description_highlights(description: str) -> list[str]:
    out = []
    for text in description.split("\n"):
        text = text.strip()
        if not re.match(r"^[-*•]\s+", text):
            continue
        text = re.sub(r"^[-*•]\s+", "", text)
        match = re.match(r"^([^:|]{2,60}):\s*(.+)$", text)
        value = f"{_line(match.group(1))}|{_line(match.group(2))}" if match else _line(text)
        if value:
            out.append(value)
    return out[:6]


def saamano_metafields(product: dict, story: dict | None) -> list[dict]:
    fields: list[dict] = []

    def add_list(key: str, items: list[str]) -> None:
        clean = [c for c in (re.sub(r"\s+", " ", i).strip() for i in items) if c]
        if clean:
            import json

            fields.append({"namespace": "saamano", "key": key, "type": "list.single_line_text_field", "value": json.dumps(clean, ensure_ascii=False, separators=(",", ":"))})

    def add_text(key: str, value: str | None, kind: str = "single_line_text_field") -> None:
        clean = (value or "").strip() if kind == "multi_line_text_field" else _line(value or "")
        if clean:
            fields.append({"namespace": "saamano", "key": key, "type": kind, "value": clean})

    add_list("highlights", description_highlights(product.get("description") or ""))
    if story:
        add_text("feature_heading", story.get("featureHeading"))
        add_text("feature_subheading", story.get("featureSubheading"))
        add_list("features", [f"{_line(c['title'])}|{_line(c['text'])}" for c in story.get("featureCards") or []])
        add_text("top_features_subheading", story.get("topFeaturesSubheading"))
        add_list("top_features", [f"{_line(c['title'])}|{_line(c['text'])}" for c in story.get("topFeatures") or []])
        add_text("compare_intro", story.get("compareIntro"), "multi_line_text_field")
        add_list("compare", [_line(r) for r in story.get("compareRows") or []])
        add_list("faq", [f"{_line(i['question'])}|{_line(i['answer'])}" for i in story.get("faq") or []])
    return fields


def _page_text(product: dict, warnings: list[str]) -> dict | None:
    name = product.get("name") or ""
    description = product.get("description") or ""
    saved = current_product_story(product["id"], name, description)
    if saved:
        return saved
    try:
        return ensure_product_story(product["id"], name, description)
    except Exception as error:  # noqa: BLE001
        warnings.append(f"The Bundle page text (feature cards, Why Choose Us and FAQ) could not be written, so it was left out: {error}")
        return None


def build_product_input(*, product: dict, image_sources: list[dict], file_video_sources: list[dict], external_videos: list[str], story: dict | None = None, update: bool = False) -> dict:
    """Status is always DRAFT and vendor is never set, so the source seller's name cannot reach it."""
    title = (product.get("name") or "").strip()
    price = product["price"].strip() if (product.get("price") or "").strip() else "0.00"
    cost = (product.get("cost") or "").strip()
    metafields = saamano_metafields(product, story)
    result: dict = {}
    if metafields:
        result["metafields"] = metafields
    if not update:
        # An update never changes the page a product already has.
        result["templateSuffix"] = new_product_template_suffix()
    if update and product.get("shopify_product_id"):
        result["id"] = product["shopify_product_id"]
    result["title"] = title
    result["handle"] = product.get("shopify_handle")
    if (product.get("category") or "").strip():
        result["productType"] = product["category"].strip()
    result["descriptionHtml"] = description_to_html(product.get("description") or "")
    result["status"] = "DRAFT"
    result["productOptions"] = [{"name": "Title", "values": [{"name": "Default Title"}]}]
    variant: dict = {"optionValues": [{"optionName": "Title", "name": "Default Title"}], "price": price, "sku": product.get("sku")}
    if cost:
        variant["inventoryItem"] = {"cost": cost}
    result["variants"] = [variant]
    if not update:
        result["files"] = [
            *({"originalSource": s["source"], "contentType": "IMAGE", "alt": title} for s in image_sources),
            *({"originalSource": s["source"], "contentType": "VIDEO", "alt": title} for s in file_video_sources),
            *({"originalSource": s, "contentType": "EXTERNAL_VIDEO", "alt": title} for s in external_videos),
        ]
    return result


def _in_background(product_id: str, work) -> None:
    context = contextvars.copy_context()

    def run():
        try:
            work(product_id)
        except Exception as error:  # noqa: BLE001
            print(f"[shopify] send failed for {product_id}:", error)
            traceback.print_exc()
            repo.set_shopify_result(product_id, status="error", error=str(error))

    threading.Thread(target=lambda: context.run(run), daemon=True).start()


def start_send(product_id: str, update: bool = False) -> dict:
    """Starts a send unless one is running or the product already exists in Shopify. The claim is atomic."""
    product = repo.get_product(product_id)
    if not product:
        return {"started": False, "reason": "Product not found", "status": 404}
    if product["stage"] != "listing":
        return {"started": False, "reason": "Only products in the Listing tab can be sent to Shopify.", "status": 409}
    settings.pin_active_store()
    if update:
        if not product["shopify_product_id"]:
            return {"started": False, "reason": "This listing is not on Shopify yet.", "status": 409}
        where = re.match(r"https?://([^/]+)/", product.get("shopify_admin_url") or "")
        if where and where.group(1).lower() != shopify_credentials()["domain"]:
            return {"started": False, "reason": f"This product is on {where.group(1)}. Switch to that store at the top right to update it.", "status": 409}
        if not repo.claim_for_update(product_id):
            return {"started": False, "reason": "This product is already being sent.", "status": 409}
        _in_background(product_id, _run_update)
        return {"started": True}
    if product["shopify_product_id"]:
        return {"started": False, "reason": "This product already exists in Shopify, so no new product was created.", "status": 409}
    missing = missing_shopify_settings()
    if missing:
        repo.set_shopify_result(product_id, status="error", error=f"Shopify is not connected. Open the Shopify tab and fill in: {', '.join(missing)}.")
        return {"started": False, "reason": "Shopify is not set up", "status": 400}
    if not (product.get("name") or "").strip():
        repo.set_shopify_result(product_id, status="error", error="The product needs a name.")
        return {"started": False, "reason": "The product needs a name.", "status": 400}
    if not repo.claim_for_sending(product_id, make_handle(product)):
        return {"started": False, "reason": "This product is already being sent.", "status": 409}
    _in_background(product_id, _run_send)
    return {"started": True}


def _user_errors(errors: list[dict]) -> str:
    return "; ".join(f"{'.'.join(e['field'])}: {e['message']}" if e.get("field") else e["message"] for e in errors)


def _run_update(product_id: str) -> None:
    product = repo.get_product(product_id)
    text_warnings: list[str] = []
    story = _page_text(product, text_warnings)
    data = graphql(PRODUCT_SET, {"input": build_product_input(product=product, image_sources=[], file_video_sources=[], external_videos=[], story=story, update=True), "synchronous": True})
    updated = data["productSet"]["product"]
    errors = data["productSet"]["userErrors"]
    if errors:
        raise ShopifyError(_user_errors(errors))
    if not updated:
        raise ShopifyError("Shopify did not return the updated product.")
    warnings = text_warnings + ([f"Shopify reports this product's status as {updated['status']}, not DRAFT. Please check it."] if updated["status"] != "DRAFT" else [])
    repo.set_shopify_result(product_id, status="draft", shopify_id=updated["id"], admin_url=_admin_url(updated["id"]), error=None, warnings=warnings)


def _run_send(product_id: str) -> None:
    product = repo.get_product(product_id)
    existing = graphql(FIND_BY_HANDLE, {"identifier": {"handle": product["shopify_handle"]}})["productByIdentifier"]
    if existing:
        warnings = ["A product from an earlier attempt was already in Shopify, so it was linked instead of creating a duplicate. Check that its media is complete."]
        if existing["status"] != "DRAFT":
            warnings.append(f"Shopify reports this product's status as {existing['status']}.")
        repo.set_shopify_result(product_id, status="draft", shopify_id=existing["id"], admin_url=_admin_url(existing["id"]), error=None, warnings=warnings)
        return

    images = [i for i in repo.list_images(product_id) if i["selected"] and i["file_name"]]
    videos = [v for v in repo.list_videos(product_id) if v["selected"]]
    file_videos = [v for v in videos if v["kind"] == "file" and v["file_name"]]
    link_videos = [v for v in videos if v["kind"] == "link" and v["url"]]
    external = [v for v in link_videos if v["provider"] in ("youtube", "vimeo")]
    warnings: list[str] = []
    for video in link_videos:
        if video not in external:
            warnings.append(f"Not attached: Shopify cannot embed this {video['provider']} link ({video['url']}).")
    if not (product.get("price") or "").strip():
        warnings.append("No selling price was set, so the draft was created at 0.00.")

    # Photos on Bunny go to Shopify as their CDN address, and Shopify fetches them itself, so nothing
    # is uploaded from here. Otherwise (and always for videos) the file is uploaded to Shopify first.
    cdn_images = [public_url(product_id, "images", i["file_name"]) for i in images]
    on_cdn = all(cdn_images)
    uploads = _upload_files([
        *([] if on_cdn else (_local_file(product_id, "images", i["file_name"]) for i in images)),
        *(_local_file(product_id, "videos", v["file_name"]) for v in file_videos),
    ])
    image_urls = cdn_images if on_cdn else uploads[: len(images)]
    video_urls = uploads if on_cdn else uploads[len(images):]
    story = _page_text(product, warnings)
    product_input = build_product_input(
        product=product,
        story=story,
        image_sources=[{"source": s} for s in image_urls],
        file_video_sources=[{"source": s} for s in video_urls],
        external_videos=[v["url"] for v in external],
    )
    data = graphql(PRODUCT_SET, {"input": product_input, "synchronous": True})
    created = data["productSet"]["product"]
    errors = data["productSet"]["userErrors"]
    if errors:
        raise ShopifyError(_user_errors(errors))
    if not created:
        raise ShopifyError("Shopify did not return the new product.")
    if created["status"] != "DRAFT":
        warnings.append(f"Shopify reports this product's status as {created['status']}, not DRAFT. Please check it.")
    # Saved before anything else that could fail, so a later problem can never create a second product.
    repo.set_shopify_result(product_id, status="draft", shopify_id=created["id"], admin_url=_admin_url(created["id"]), error=None, warnings=warnings)
    try:
        _report_media_problems(product_id, created["id"], warnings)
    except Exception as error:  # noqa: BLE001
        print(f"[shopify] could not read media status for {product_id}:", error)


def _report_media_problems(product_id: str, gid: str, warnings: list[str]) -> None:
    deadline = time.time() + 90
    while True:
        data = graphql(MEDIA_STATUS, {"id": gid})
        nodes = ((data.get("product") or {}).get("media") or {}).get("nodes") or []
        failed = [n for n in nodes if n["status"] == "FAILED"]
        pending = [n for n in nodes if n["status"] in ("UPLOADED", "PROCESSING")]
        if not pending or time.time() > deadline:
            notes = [
                f"A {n['mediaContentType'].lower().replace('_', ' ', 1)} failed in Shopify: {'; '.join(e['message'] for e in n['mediaErrors']) or 'no reason given'}"
                for n in failed
            ]
            if pending:
                notes.append(f"{len(pending)} media item(s) were still processing in Shopify. Check them in the draft.")
            if notes:
                repo.set_shopify_result(product_id, status="draft", warnings=[*warnings, *notes])
            return
        time.sleep(3)

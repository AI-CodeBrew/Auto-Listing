"""The research job: find pictures, pages and videos for a product, then write its text."""
from __future__ import annotations

import os
import re

from .. import ai, config, repo
from ..config import LIMITS
from ..media.images import DUPLICATE_DISTANCE, download_image, for_vision, hamming_distance, inspect_image_file, jpeg_for_lens
from ..media.videos import download_video, extract_frames
from ..search import bing
from ..search.fastmoss import search_videos
from ..search.marketplaces import marketplace_of_hit
from ..search.serpapi import lens_search, search_images, upload_lens_image
from ..settings import fastmoss_api_key
from ..storage import clear_research_files, ensure_dirs, fetch_inputs, media_path
from ..web.errors import BlockedError, SearchDisallowedError
from ..web.extract import extract_page
from ..web.robots import is_allowed_by_robots, polite_wait
from ..web.urls import classify_video, domain_of, exclusion_reason, filter_product_urls, normalize_url
from .text import choose_best_images, find_copied_phrases, finalize_listing


class JobBlocked(Exception):
    """Stops the job with BLOCKED and a message for the user."""

    def __init__(self, message: str, blocked_urls: list[str]):
        super().__init__(message)
        self.message = message
        self.blocked_urls = blocked_urls


PASTE_URLS_MESSAGE = "Paste product page URLs below to continue without searching."
IMAGE_SEARCH_PAGES = 2
IMAGE_CHECKS_PER_SEARCH_PAGE = 25
IMAGE_SEARCH_STOP_AT = 8
TEXT_PAGES_TO_TRY = 5


class RunState:
    def __init__(self, job: dict, product: dict):
        self.job = job
        self.product = product
        self.reference: list[bytes] = []
        self.vision: dict | None = None
        self.seen_pages: set[str] = {normalize_url(u) for u in product["blocked_urls"]}
        self.seen_media: set[str] = set()
        self.accepted: list[dict] = []
        self.video_downloads = 0
        self.ai_checks = 0
        self.warnings: list[str] = []
        self.search_unavailable = job["skip_search"]
        self.search_block: str | None = None
        self.blocked_pages: list[dict] = []
        self.search_hits: dict[str, dict] = {}
        self.fastmoss: list[dict] = []


def safe_domain(url: str) -> str:
    try:
        return domain_of(url)
    except Exception:  # noqa: BLE001
        return url


def short_error(error: BaseException) -> str:
    return str(error).split("\n")[0][:200]


def run_research(job: dict) -> None:
    product = repo.get_product(job["product_id"])
    if not product:
        raise RuntimeError("Product no longer exists")
    repo.set_usage(job["id"], repo.empty_usage())

    def step(text: str) -> None:
        repo.set_job_step(job["id"], text)

    step("Looking up the product")
    ai.ai_preflight()

    # Web results start clean each run, so a job resumed after a restart cannot double them up.
    repo.reset_research(product["id"])
    repo.update_product(product["id"], {"stage": "researching"})
    keep = [f for f in [product["input_image"], product["input_video"], *product["input_images"]] if f]
    clear_research_files(product["id"], keep)
    ensure_dirs(product["id"])
    product = repo.get_product(product["id"])
    # With Bunny, the user's uploads live there between jobs; research reads them from the local disk.
    fetch_inputs(product)

    state = RunState(job, product)
    prepare_inputs(state, step)
    keywords = keywords_for(state)
    query = " ".join(keywords).strip()

    want_photos = product["search_photos"]
    want_videos = product["search_videos"]
    image_mode = want_photos and bool(config.serp_api_key()) and not job["skip_search"] and (bool(query) or bool(product["input_image"]))

    if not want_photos:
        state.warnings.append("Photo search was turned off, so no pictures were searched.")
        pasted = filter_product_urls(product["input_urls"], state.seen_pages)
        for item in pasted["dropped"]:
            repo.add_source(product["id"], url=item["url"], status="rejected", reason=item["reason"])
        if pasted["keep"]:
            visit_pages(state, pasted["keep"][: LIMITS.pages_per_try], step)
    elif image_mode:
        run_image_search(state, query, step)
    else:
        tries = 0
        max_tries = 1 + LIMITS.extra_search_tries
        while tries < max_tries:
            tries += 1
            step(
                f'Finding product pages for "{query}"' if tries == 1
                else f"Fewer than {LIMITS.target_images} images passed. Searching more pages (try {tries - 1} of {LIMITS.extra_search_tries})"
            )
            urls = next_page_urls(state, query, tries)
            if not urls:
                break
            visit_pages(state, urls, step)
            if passed_image_count(product["id"]) >= LIMITS.target_images:
                break
            if state.search_unavailable:
                break

    if want_videos:
        search_fastmoss(state, query, step)

    if not image_mode and not state.accepted and (state.blocked_pages or state.search_block):
        parts = [p for p in (state.search_block, state.blocked_pages and f"{describe_blocked_sites(state)} showed a CAPTCHA or bot block.") if p]
        raise JobBlocked(f"{' '.join(parts)} {PASTE_URLS_MESSAGE}", [p["url"] for p in state.blocked_pages])
    if state.search_block:
        state.warnings.append(f"{state.search_block} The search stopped there, so only pages found before that and your pasted URLs were used.")
    if state.blocked_pages:
        state.warnings.append(f"These sites blocked automated access, so their pages were skipped: {describe_blocked_sites(state)}.")

    passed = passed_image_count(product["id"])
    low_images = want_photos and passed < LIMITS.target_images
    if want_photos and not image_mode and not state.accepted:
        state.warnings.append("No matching product pages were found. Check the text carefully, or use Search Again with pasted URLs.")

    step("Writing the title and description from your photo" if product["input_image"] else "Writing the product name, category and description")
    text = write_text(state)

    images = repo.list_images(product["id"])
    best = choose_best_images(images, LIMITS.max_preselected_images)
    others = [image["id"] for image in images if image["id"] not in best]
    repo.rank_images(product["id"], [*best, *others], best)

    source_parts = [
        "\n\n---\n\n".join(f"From {p['seller']} ({p['url']}):\n{p['text']}" for p in state.accepted),
        "\n".join(
            f"FastMoss video: {v['title'] or v['url']}{' by ' + v['creator'] if v['creator'] else ''} ({v['url']})" for v in state.fastmoss
        ),
    ]
    repo.update_product(product["id"], {
        "stage": "review",
        "name": text["name"],
        "name_options": text["nameOptions"],
        "category": text["category"] or vision_category(state),
        "description": text["description"],
        "claims": text["claims"],
        "source_text": "\n\n---\n\n".join(p for p in source_parts if p) or None,
        "seller_name": state.accepted[0]["seller"] if state.accepted else None,
        "low_images": low_images,
        "warnings": state.warnings,
        "vision": state.vision,
    })
    repo.archive_other_reviews(product["id"])


def lens_matches(state: RunState, step) -> list[dict]:
    product = state.product
    if not product["input_image"]:
        return []
    step("Sending your photo to Google Lens")
    try:
        jpeg = jpeg_for_lens(media_path(product["id"], "images", product["input_image"]))
        image_id = upload_lens_image(jpeg)
        hits = lens_search(image_id)
        if not hits:
            state.warnings.append("Google Lens found no pictures that match your photo.")
        return hits
    except Exception as error:  # noqa: BLE001
        state.warnings.append(f"Google Lens could not search your photo: {error}")
        return []


def check_hits(state: RunState, hits: list[dict], step, stop_at: int = IMAGE_SEARCH_STOP_AT) -> None:
    product = state.product
    try_limit = stop_at if stop_at > IMAGE_SEARCH_STOP_AT else IMAGE_CHECKS_PER_SEARCH_PAGE
    tried = 0
    for hit in hits:
        if tried >= try_limit:
            break
        if stop_at <= IMAGE_SEARCH_STOP_AT and passed_image_count(product["id"]) >= stop_at:
            break
        page = hit["pageUrl"] or hit["original"]
        if hit["original"] in state.seen_media:
            continue
        if not hit.get("imageOnly") and exclusion_reason(page):
            continue
        if not hit.get("imageOnly") and hit.get("width") and hit.get("height") and (hit["width"] < LIMITS.image_min_side or hit["height"] < LIMITS.image_min_side):
            continue
        state.search_hits[hit["original"]] = hit
        tried += 1
        market = marketplace_of_hit(hit)
        label = "Google Lens" if hit.get("imageOnly") else (market["label"] if market else safe_domain(page))
        step(f"Checking image {tried} ({label})")
        process_image(state, [hit["original"]], "" if hit.get("imageOnly") else page, skip_robots=bool(hit.get("imageOnly") or market), skip_ai=bool(hit.get("imageOnly")))


def run_image_search(state: RunState, query: str, step) -> None:
    product = state.product
    pasted = filter_product_urls(product["input_urls"], state.seen_pages)
    for item in pasted["dropped"]:
        repo.add_source(product["id"], url=item["url"], status="rejected", reason=item["reason"])
    if pasted["keep"]:
        visit_pages(state, pasted["keep"][: LIMITS.pages_per_try], step)

    if product["input_image"]:
        photos = lens_matches(state, step)
        if photos:
            step(f"Saving {len(photos)} matching photo{'' if len(photos) == 1 else 's'} from Google Lens")
            check_hits(state, photos, step, max(len(photos), IMAGE_SEARCH_STOP_AT + 1))
        return

    for page_index in range(IMAGE_SEARCH_PAGES):
        if passed_image_count(product["id"]) >= LIMITS.target_images:
            break
        step(
            f'Searching Google Images for "{query}"' if page_index == 0
            else f'Fewer than {LIMITS.target_images} images passed. Searching Google Images for "{query}" (page {page_index + 1})'
        )
        hits = search_images(query, page_index)
        if not hits:
            break
        check_hits(state, hits, step)

    if not state.search_hits and not state.accepted:
        raise JobBlocked(f'Google Images found no usable pictures for "{query}". {PASTE_URLS_MESSAGE}', [])

    passing = [i for i in repo.list_images(product["id"]) if i["passed"] and not i["uploaded"] and i["source_page"]]
    passing.sort(key=lambda i: i["checks"].get("quality") or 0, reverse=True)
    best_pages: list[str] = []
    for image in passing:
        if image["source_page"] not in best_pages:
            best_pages.append(image["source_page"])
    to_read = filter_product_urls(best_pages, state.seen_pages)["keep"][:TEXT_PAGES_TO_TRY]
    if to_read:
        visit_pages(state, to_read, step, verify=False)

    if state.blocked_pages and not state.accepted:
        state.warnings.append(f"These sites blocked automated access, so their pages could not be read: {describe_blocked_sites(state)}.")
    if not state.accepted:
        state.warnings.append("No product page could be read, so the text is based on your photo, your product name and titles from Google Images. Check it carefully, or use Search Again with pasted URLs.")


def describe_blocked_sites(state: RunState) -> str:
    sites: dict[str, str] = {}
    for page in state.blocked_pages:
        sites.setdefault(safe_domain(page["url"]), page["reason"])
    return ", ".join(f"{site} ({reason})" for site, reason in sites.items())


def passed_image_count(product_id: str) -> int:
    return sum(1 for image in repo.list_images(product_id) if image["passed"])


def keywords_for(state: RunState) -> list[str]:
    name = state.product["input_name"]
    if state.vision:
        words = state.vision["search_keywords"][:1]
        return [name] if name else (words if words else [state.vision["product_type"]])
    return [name] if name else []


def prepare_inputs(state: RunState, step) -> None:
    """Analyzes the uploaded image or video frames and registers the user's own files. Each result is saved at once."""
    product = state.product
    state.vision = product["vision"]

    if product["input_image"]:
        file = media_path(product["id"], "images", product["input_image"])
        state.reference = [for_vision(file)]
        lens_photo = bool(config.serp_api_key()) and product["search_photos"] and not state.job["skip_search"]
        if not lens_photo:
            if state.vision:
                step("Using the earlier analysis of your image")
            else:
                step("Analyzing your image")
                state.vision = ai.analyze_product_images(state.reference, product["input_name"])
                repo.update_product(product["id"], {"vision": state.vision})
        check_uploaded_image(state, product["input_image"])
        for extra in product["input_images"] or []:
            if extra != product["input_image"]:
                check_uploaded_image(state, extra)

    if product["input_video"]:
        step("Extracting frames from your video")
        file = media_path(product["id"], "videos", product["input_video"])
        frames = extract_frames(file)
        if not frames:
            raise RuntimeError("No frames could be read from the uploaded video. Try an MP4, MOV or WEBM file.")
        state.reference = [for_vision(frame) for frame in frames]
        if state.vision:
            step("Using the earlier analysis of your video")
        else:
            step(f"Extracted {len(frames)} frames. Analyzing them")
            state.vision = {**ai.analyze_product_images(state.reference, product["input_name"]), "frames_analyzed": len(frames)}
            repo.update_product(product["id"], {"vision": state.vision})
        if not any(v["uploaded"] for v in repo.list_videos(product["id"])):
            repo.add_video({
                "product_id": product["id"], "kind": "file", "provider": None, "url": None,
                "file_name": product["input_video"], "source_page": None, "bytes": os.path.getsize(file),
                "passed": True, "reason": None, "selected": True, "uploaded": True,
            })


def check_uploaded_image(state: RunState, file_name: str) -> None:
    product = state.product
    existing = next((i for i in repo.list_images(product["id"]) if i["uploaded"] and i["file_name"] == file_name), None)
    if existing and (existing["checks"].get("aiChecked") or existing["passed"] or existing["reason"]):
        return
    info = inspect_image_file(product["id"], file_name)
    too_small = info["width"] < LIMITS.image_min_side or info["height"] < LIMITS.image_min_side
    row = existing or repo.add_image({
        "product_id": product["id"], "file_name": file_name, "source_url": None, "source_page": None,
        "width": info["width"], "height": info["height"], "bytes": info["bytes"], "phash": info["phash"],
        "passed": False, "reason": None, "checks": {"minSize": not too_small, "duplicate": False, "aiChecked": False}, "uploaded": True,
    })
    if too_small:
        repo.update_image_check(row["id"], False, f"Too small: {info['width']}x{info['height']} (minimum {LIMITS.image_min_side}x{LIMITS.image_min_side})", row["checks"])
    else:
        repo.update_image_check(row["id"], True, None, {**row["checks"], "minSize": True, "aiChecked": False})


def next_page_urls(state: RunState, query: str, try_number: int) -> list[str]:
    candidates: list[str] = list(state.product["input_urls"]) if try_number == 1 else []
    if not state.search_unavailable and query:
        try:
            candidates.extend(bing.search(query, (try_number - 1) * 10))
        except BlockedError as error:
            state.search_unavailable = True
            state.search_block = f"{bing.NAME} showed a CAPTCHA or bot check ({error.message})."
        except SearchDisallowedError:
            state.search_unavailable = True
            if not candidates:
                raise JobBlocked(f"{bing.NAME}'s robots.txt does not allow automated search, so no search was run. {PASTE_URLS_MESSAGE}", [])
            state.warnings.append(f"{bing.NAME} search was skipped because its robots.txt does not allow automated search. Only your pasted URLs were used.")
    result = filter_product_urls(candidates, state.seen_pages)
    for item in result["dropped"]:
        repo.add_source(state.product["id"], url=item["url"], status="rejected", reason=item["reason"])
    return result["keep"][: LIMITS.pages_per_try]


def browser_cannot_start(error: BaseException) -> bool:
    return bool(re.search(r"browsers\.json|Executable doesn't exist|Failed to launch|browserType\.launch|BrowserType\.launch", str(error), re.I))


def visit_pages(state: RunState, urls: list[str], step, verify: bool = True) -> None:
    from ..web import browser

    product = state.product
    for index, url in enumerate(urls):
        label = f"page {index + 1} of {len(urls)} ({safe_domain(url)})"
        step(f"Opening {label}")

        earlier = next((p for p in state.blocked_pages if safe_domain(p["url"]) == safe_domain(url)), None)
        if earlier:
            state.blocked_pages.append({"url": url, "reason": earlier["reason"]})
            repo.add_source(product["id"], url=url, status="rejected", reason=f"Skipped: this site blocked an earlier page ({earlier['reason']})")
            continue

        if not is_allowed_by_robots(url):
            repo.add_source(product["id"], url=url, status="rejected", reason="robots.txt does not allow automated access")
            continue
        polite_wait(url)

        def load(page, url=url):
            response = browser.open_page(page, url)
            if response is not None and response.status >= 400:
                raise RuntimeError(f"the site answered HTTP {response.status}")
            return extract_page(page)

        try:
            data = browser.with_page(load)
        except BlockedError as error:
            state.blocked_pages.append({"url": url, "reason": error.message})
            repo.add_source(product["id"], url=url, status="rejected", reason=f"Blocked: {error.message}")
            continue
        except Exception as error:  # noqa: BLE001
            if browser_cannot_start(error):
                step("Product pages cannot be opened from this server. Continuing with the search results.")
                state.warnings.append("Product pages could not be opened from this server, so the text uses your details and the search results.")
                return
            repo.add_source(product["id"], url=url, status="rejected", reason=f"Could not open the page: {short_error(error)}")
            continue

        if verify:
            step(f"Comparing {label} with your product")
            verdict = ai.compare_same_product(
                reference=state.reference,
                name=product["input_name"],
                page={"url": data["url"], "title": data["title"], "seller": data["seller"], "text": data["text"]},
                screenshot=for_vision(data["screenshot"]) if data["screenshot"] else None,
            )
            if not verdict["same_product"]:
                repo.add_source(product["id"], url=url, title=data["title"], seller=data["seller"], status="rejected", reason=f"Different product: {verdict['reason']}", text=data["text"])
                continue
            repo.add_source(product["id"], url=url, title=data["title"], seller=data["seller"], status="accepted", reason=verdict["reason"], text=data["text"])
        else:
            repo.add_source(product["id"], url=url, title=data["title"], seller=data["seller"], status="accepted", reason="A picture from this page passed the checks", text=data["text"])
        state.accepted.append(data)

        if verify and state.product["search_photos"]:
            step(f"Downloading images from {label}")
            for candidate in data["images"]:
                process_image(state, candidate["urls"], data["url"])
        if state.product["search_videos"] and not fastmoss_api_key():
            step(f"Checking videos from {label}")
            collect_videos(state, data)


def process_image(state: RunState, candidate_urls: list[str], source_page: str, skip_robots: bool = False, skip_ai: bool = False) -> None:
    """Downloads one picture (the first URL that works) and runs the size and duplicate checks."""
    product_id = state.product["id"]
    urls: list[str] = []
    for url in candidate_urls:
        if url in state.seen_media:
            continue
        if skip_robots:
            urls.append(url)
            continue
        try:
            allowed = is_allowed_by_robots(url)
        except Exception:  # noqa: BLE001
            allowed = False
        if allowed:
            urls.append(url)
    if not urls:
        return
    state.seen_media.update(urls)

    polite_wait(urls[0], min(500, config.request_delay_ms()))
    downloaded = download_image(product_id, urls)
    if downloaded["status"] == "skip":
        return
    empty_checks = {"minSize": False, "duplicate": False, "aiChecked": False}
    if downloaded["status"] == "too-large":
        repo.add_image({
            "product_id": product_id, "file_name": None, "source_url": urls[0], "source_page": source_page, "width": None, "height": None,
            "bytes": None, "phash": None, "passed": False, "reason": downloaded["message"], "checks": empty_checks, "uploaded": False,
        })
        return

    width, height, phash = downloaded["width"], downloaded["height"], downloaded["phash"]
    row = repo.add_image({
        "product_id": product_id, "file_name": downloaded["fileName"], "source_url": downloaded["finalUrl"], "source_page": source_page,
        "width": width, "height": height, "bytes": downloaded["bytes"], "phash": phash,
        "passed": False, "reason": None, "checks": dict(empty_checks), "uploaded": False,
    })

    min_size = width >= LIMITS.image_min_side and height >= LIMITS.image_min_side
    if not min_size and not skip_ai:
        repo.update_image_check(row["id"], False, f"Too small: {width}x{height} (minimum {LIMITS.image_min_side}x{LIMITS.image_min_side})", {**row["checks"], "minSize": False})
        return
    twins = [
        other for other in repo.list_images(product_id)
        if other["id"] != row["id"] and other["phash"] and other["file_name"] and other["checks"].get("minSize")
        and not other["checks"].get("duplicate") and hamming_distance(other["phash"], phash) <= DUPLICATE_DISTANCE
    ]
    area = width * height
    if any(t["uploaded"] or (t["width"] or 0) * (t["height"] or 0) >= area for t in twins):
        repo.update_image_check(row["id"], False, "Duplicate of another image", {**row["checks"], "minSize": True, "duplicate": True})
        return
    for twin in twins:
        repo.update_image_check(twin["id"], False, "Duplicate of a larger image", {**twin["checks"], "duplicate": True})
    repo.update_image_check(row["id"], True, None, {**row["checks"], "minSize": True, "aiChecked": False})


def search_fastmoss(state: RunState, query: str, step) -> None:
    if not fastmoss_api_key():
        state.warnings.append("Video setup is not integrated yet.")
        return
    if not query:
        state.warnings.append("Video search was skipped because there is no product name to search for.")
        return
    step(f'Searching FastMoss for videos of "{query}"')
    try:
        hits = search_videos(query)
        state.fastmoss = hits
        if not hits:
            state.warnings.append(f'FastMoss found no videos for "{query}".')
            return
        for index, hit in enumerate(hits):
            classified = classify_video(hit["url"])
            provider = classified["provider"] if classified and classified["kind"] == "link" else "fastmoss"
            attachable = provider in ("youtube", "vimeo")
            repo.add_video({
                "product_id": state.product["id"], "kind": "link", "provider": provider,
                "url": classified["url"] if classified else hit["url"], "file_name": None, "source_page": hit["pageUrl"] or None,
                "bytes": None, "passed": True,
                "reason": None if attachable else "Link only. Shopify can attach YouTube and Vimeo links, not this one.",
                "selected": index < 5, "uploaded": False,
            })
    except Exception as error:  # noqa: BLE001
        state.warnings.append(f"FastMoss video search failed: {error}")


def collect_videos(state: RunState, page: dict) -> None:
    product_id = state.product["id"]
    for url in page["videos"]:
        video = classify_video(url)
        if not video:
            continue
        key = video["url"]
        if key in state.seen_media:
            continue
        state.seen_media.add(key)

        if video["kind"] == "link":
            attachable = video["provider"] in ("youtube", "vimeo")
            repo.add_video({
                "product_id": product_id, "kind": "link", "provider": video["provider"], "url": video["url"], "file_name": None,
                "source_page": page["url"], "bytes": None, "passed": True,
                "reason": None if attachable else "Link only. Shopify can attach YouTube and Vimeo links, not this one.",
                "selected": False, "uploaded": False,
            })
            continue

        base = {"product_id": product_id, "kind": "file", "provider": None, "url": video["url"], "source_page": page["url"], "uploaded": False}
        if state.video_downloads >= LIMITS.max_video_downloads:
            repo.add_video({**base, "file_name": None, "bytes": None, "passed": False, "reason": f"Not downloaded: limit of {LIMITS.max_video_downloads} videos per product reached", "selected": False})
            continue
        try:
            allowed = is_allowed_by_robots(video["url"])
        except Exception:  # noqa: BLE001
            allowed = False
        if not allowed:
            repo.add_video({**base, "file_name": None, "bytes": None, "passed": False, "reason": "robots.txt does not allow downloading this file", "selected": False})
            continue
        state.video_downloads += 1
        polite_wait(video["url"], min(500, config.request_delay_ms()))
        downloaded = download_video(product_id, video["url"])
        if downloaded["status"] == "failed":
            repo.add_video({**base, "file_name": None, "bytes": None, "passed": False, "reason": downloaded["reason"], "selected": False})
            continue
        frames = extract_frames(media_path(product_id, "videos", downloaded["fileName"]))
        if not frames:
            repo.add_video({**base, "file_name": downloaded["fileName"], "bytes": downloaded["bytes"], "passed": False, "reason": "No frames could be read from this video", "selected": False})
            continue
        check = ai.check_video_frames(
            frames=[for_vision(frame) for frame in frames],
            reference=state.reference,
            name=state.product["input_name"],
            product_type=(state.vision or {}).get("product_type"),
            source_url=video["url"],
        )
        failures = [f for f in (
            not check["correct_product"] and "wrong product",
            not check["clear"] and "not clear",
            not check["no_other_brand_logo"] and "shows another brand's logo",
        ) if f]
        passed = not failures
        reason = None if passed else ": ".join(x for x in (", ".join(failures), check["reason"]) if x)
        repo.add_video({**base, "file_name": downloaded["fileName"], "bytes": downloaded["bytes"], "passed": passed, "reason": reason, "selected": passed})


def vision_category(state: RunState) -> str | None:
    kind = re.sub(r"\s+", " ", ((state.vision or {}).get("product_type") or "")).strip()
    return kind[:60] if kind else None


def write_text(state: RunState) -> dict:
    product, accepted, vision = state.product, state.accepted, state.vision
    if product["input_image"] and state.reference and config.serp_api_key() and product["search_photos"]:
        draft = ai.write_listing(name=product["input_name"], details=product["input_details"], vision=None, sellers_to_remove=[], pages=[], images=state.reference[:1])
        return finalize_listing(draft, [], product["input_name"] or (vision or {}).get("product_type") or "Untitled product")

    sellers: list[str] = []
    for page in accepted:
        for value in (page["seller"], safe_domain(page["url"])):
            if value and value not in sellers:
                sellers.append(value)
    pages = [{"url": p["url"], "title": p["title"], "seller": p["seller"], "text": p["text"]} for p in accepted[: LIMITS.pages_per_try]]

    visited = {p["url"] for p in accepted}
    passed_pages = {i["source_page"] for i in repo.list_images(product["id"]) if i["passed"] and i["source_page"]}
    titled = [h for h in state.search_hits.values() if h["title"] and h["pageUrl"] and h["pageUrl"] in passed_pages and h["pageUrl"] not in visited]
    for hit in titled[:5]:
        pages.append({"url": hit["pageUrl"], "title": hit["title"], "seller": hit["source"], "text": hit["title"]})
        sellers.extend([hit["source"], safe_domain(hit["pageUrl"])])
    for video in state.fastmoss[:5]:
        text = " — ".join(x for x in (video["title"], video["creator"]) if x) or video["url"]
        pages.append({"url": video["url"], "title": video["title"] or "FastMoss video", "seller": video["creator"] or "FastMoss", "text": text})
        if video["creator"]:
            sellers.append(video["creator"])
    source_texts = [p["text"] for p in accepted]
    request = {"name": product["input_name"], "details": product["input_details"], "vision": vision, "sellers_to_remove": sellers, "pages": pages}

    draft = ai.write_listing(**request)

    def full_text(d: dict) -> str:
        return " ".join([d["description"], *d["feature_bullets"]])

    copied = find_copied_phrases(full_text(draft), source_texts)
    if copied:
        draft = ai.write_listing(**request, avoid_phrases=copied)
        copied = find_copied_phrases(full_text(draft), source_texts)
        if copied:
            state.warnings.append(f'The description still repeats wording from a source, for example: "{copied[0]}". Please reword it.')
    fallback = product["input_name"] if product["input_name"] is not None else ((vision or {}).get("product_type") or "Untitled product")
    return finalize_listing(draft, sellers, fallback)

"""Every HTTP route. Same paths, status codes and JSON as the old Next.js API, plus accounts,
billing and the admin portal."""
from __future__ import annotations

import contextvars
import io
import json
import os
import re
import shutil
import threading
import traceback
import uuid
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile

from . import accounts, config, db, repo, settings
from .accounts import AccountError
from .ai import AiError, ai_status
from .config import LIMITS
from .costs import price_usage
from .storage import commit_file, ensure_local, is_safe_kind, media_path, public_url, publish_files, remove_quietly, temp_path

SESSION_COOKIE = "pla_session"
ROLE_COOKIE = "pla_role"
LOCAL_HOSTS = {"localhost", "127.0.0.1", "[::1]"}
VIDEO_TYPES = {"video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm"}
VIDEO_EXT = re.compile(r"\.(mp4|mov|webm)$", re.I)
ALL_STAGES = ["researching", "blocked", "failed", "review", "listing", "rejected", "history"]
MONEY = re.compile(r"^\d+(\.\d{1,2})?$")


# ---------- helpers ----------

def ok(body, status: int = 200) -> JSONResponse:
    return JSONResponse(body, status_code=status, headers={"cache-control": "no-store"})


def fail(message: str, status: int = 400) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status, headers={"cache-control": "no-store"})


def _host(request: Request) -> str:
    # The frontend forwards the address the browser used.
    return request.headers.get("x-pla-host") or request.headers.get("host") or ""


def reject_foreign_request(request: Request) -> JSONResponse | None:
    """Requests that change data must come from this app's own pages."""
    host = _host(request)
    site = request.headers.get("sec-fetch-site")
    if site and site not in ("same-origin", "none"):
        return fail("Cross-site request refused.", 403)
    origin = request.headers.get("origin")
    if origin:
        try:
            origin_host = urlsplit(origin).netloc.lower()
        except ValueError:
            return fail("Cross-site request refused.", 403)
        if not origin_host or origin_host != host.lower():
            return fail("Cross-site request refused.", 403)
    if re.sub(r":\d+$", "", host).lower() in LOCAL_HOSTS:
        return None
    if origin or site in ("same-origin", "none"):
        return None
    return fail("Requests must use localhost.", 403)


def parse_url_list(value) -> tuple[list[str], list[str]]:
    from .jsurl import URL, URLError

    lines = [str(v) for v in value] if isinstance(value, list) else re.split(r"[\r\n,]+", str(value or ""))
    urls: list[str] = []
    invalid: list[str] = []
    for line in lines:
        trimmed = line.strip()
        if not trimmed:
            continue
        try:
            url = URL(trimmed)
        except URLError:
            invalid.append(trimmed)
            continue
        if url.protocol in ("http:", "https:"):
            if url.href not in urls:
                urls.append(url.href)
        else:
            invalid.append(trimmed)
    return urls, invalid


async def json_body(request: Request, default=None):
    try:
        return await request.json()
    except Exception:  # noqa: BLE001
        return default


def current_user(request: Request) -> dict | None:
    return accounts.session_user(request.cookies.get(SESSION_COOKIE))


def workspace(user: dict) -> str | None:
    """None is the admin's workspace (and every listing made before accounts existed)."""
    return None if user["role"] == "admin" else user["id"]


def bind_workspace(user: dict) -> None:
    settings.current_owner.set(workspace(user))


def owned_product(user: dict, product_id: str) -> dict | None:
    product = repo.get_product(product_id)
    if not product:
        return None
    return product if repo.product_owner(product_id) == workspace(user) else None


def set_session(response: Response, request: Request, token: str, role: str) -> None:
    secure = request.headers.get("x-forwarded-proto") == "https" or request.url.scheme == "https"
    age = accounts.SESSION_DAYS * 86400
    response.set_cookie(SESSION_COOKIE, token, max_age=age, httponly=True, samesite="lax", secure=secure, path="/")
    # Only a hint for the frontend's page redirects. Every API call checks the real session.
    response.set_cookie(ROLE_COOKIE, role, max_age=age, httponly=False, samesite="lax", secure=secure, path="/")


def clear_session(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/")
    response.delete_cookie(ROLE_COOKIE, path="/")


def _in_background(fn, *args) -> None:
    context = contextvars.copy_context()

    def run():
        try:
            fn(*args)
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    threading.Thread(target=lambda: context.run(run), daemon=True).start()


# ---------- app ----------

def create_app() -> FastAPI:
    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        def startup():
            db.conn()
            accounts.ensure_schema()
            if not config.on_vercel():
                from .queue import start_worker

                start_worker()

        await run_in_threadpool(startup)
        yield

    app = FastAPI(title="Product Listing Assistant API", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)

    @app.middleware("http")
    async def guard(request: Request, call_next):
        try:
            return await call_next(request)
        except Exception:  # noqa: BLE001
            traceback.print_exc()
            return fail("Something went wrong on the server.", 500)

    def need_user(request: Request) -> tuple[dict | None, JSONResponse | None]:
        user = current_user(request)
        if not user:
            return None, fail("Please log in.", 401)
        bind_workspace(user)
        return user, None

    def need_admin(request: Request) -> tuple[dict | None, JSONResponse | None]:
        user = current_user(request)
        if not user:
            return None, fail("Please log in.", 401)
        if user["role"] != "admin":
            return None, fail("Only the admin can do this.", 403)
        bind_workspace(user)
        return user, None

    # ===== Accounts =====

    @app.post("/api/auth/signup")
    async def signup(request: Request):
        refused = reject_foreign_request(request)
        if refused:
            return refused
        body = await json_body(request, {}) or {}
        try:
            user = await run_in_threadpool(accounts.sign_up, str(body.get("name") or ""), str(body.get("email") or ""), str(body.get("password") or ""))
        except AccountError as error:
            return fail(error.message, error.status)
        response = ok({"role": "user", "user": user}, 201)
        set_session(response, request, accounts.make_token(user["id"], "user"), "user")
        return response

    @app.post("/api/auth/login")
    async def login(request: Request):
        refused = reject_foreign_request(request)
        if refused:
            return refused
        body = await json_body(request, {}) or {}
        try:
            user = await run_in_threadpool(accounts.log_in, str(body.get("email") or ""), str(body.get("password") or ""))
        except AccountError as error:
            return fail(error.message, error.status)
        response = ok({"role": "user", "user": user})
        set_session(response, request, accounts.make_token(user["id"], "user"), "user")
        return response

    @app.post("/api/admin/login")
    async def admin_login(request: Request):
        refused = reject_foreign_request(request)
        if refused:
            return refused
        body = await json_body(request, {}) or {}
        try:
            accounts.admin_log_in(str(body.get("email") or ""), str(body.get("password") or ""))
        except AccountError as error:
            return fail(error.message, error.status)
        response = ok({"role": "admin", "user": {"id": accounts.ADMIN_ID, "email": accounts.admin_email(), "name": "Admin"}})
        set_session(response, request, accounts.make_token(accounts.ADMIN_ID, "admin"), "admin")
        return response

    @app.post("/api/auth/logout")
    async def logout(request: Request):
        response = ok({"ok": True})
        clear_session(response)
        return response

    @app.get("/api/auth/me")
    def me(request: Request):
        user = current_user(request)
        if not user:
            response = fail("Please log in.", 401)
            clear_session(response)
            return response
        return ok({"role": user["role"], "user": user})

    @app.get("/api/account")
    def account(request: Request):
        user, denied = need_user(request)
        if denied:
            return denied
        if user["role"] == "admin":
            return ok({"user": {**user, "searchesAllowed": None, "searchesUsed": None, "searchesLeft": None, "unlimited": True}, "history": []})
        return ok(accounts.user_overview(user["id"]))

    @app.get("/api/billing")
    def billing(request: Request):
        user, denied = need_user(request)
        if denied:
            return denied
        if user["role"] == "admin":
            return ok({"plans": accounts.list_plans(), "requests": [], "user": user})
        return ok({"plans": accounts.list_plans(), "requests": accounts.user_requests(user["id"]), "user": accounts.user_overview(user["id"])["user"]})

    @app.post("/api/billing/request")
    async def billing_request(request: Request):
        refused = reject_foreign_request(request)
        if refused:
            return refused
        user, denied = need_user(request)
        if denied:
            return denied
        if user["role"] == "admin":
            return fail("The admin has unlimited searches.", 400)
        body = await json_body(request, {}) or {}
        try:
            created = accounts.request_plan(user["id"], str(body.get("planId") or ""), str(body.get("paymentNote") or ""))
        except AccountError as error:
            return fail(error.message, error.status)
        return ok({"request": created}, 201)

    # ===== Admin portal =====

    @app.get("/api/admin/overview")
    def admin_overview(request: Request):
        _, denied = need_admin(request)
        if denied:
            return denied
        from .search.serpapi import serp_overview

        totals = repo.usage_totals(repo.ALL)
        return ok({
            "accounts": accounts.admin_totals(),
            "app": {
                "requests": totals["requests"],
                "shopifyDrafts": totals["shopifyDrafts"],
                "cost": price_usage(totals["usage"]),
                "counts": repo.count_by_stage(repo.ALL),
            },
            "serpapi": serp_overview(),
            "ai": ai_status(),
            "model": config.openai_model() if config.ai_provider() == "openai" else config.ai_model(),
            "provider": config.ai_provider(),
        })

    @app.get("/api/admin/users")
    def admin_users(request: Request):
        _, denied = need_admin(request)
        if denied:
            return denied
        return ok({"users": accounts.list_users()})

    @app.get("/api/admin/users/{user_id}")
    def admin_user(request: Request, user_id: str):
        _, denied = need_admin(request)
        if denied:
            return denied
        try:
            overview = accounts.user_overview(user_id)
        except AccountError as error:
            return fail(error.message, error.status)
        return ok({**overview, "requests": accounts.user_requests(user_id), "usage": repo.usage_totals(user_id)})

    @app.patch("/api/admin/users/{user_id}")
    async def admin_update_user(request: Request, user_id: str):
        refused = reject_foreign_request(request)
        if refused:
            return refused
        _, denied = need_admin(request)
        if denied:
            return denied
        body = await json_body(request, {}) or {}

        def as_int(key):
            if body.get(key) is None or body.get(key) == "":
                return None
            try:
                return int(body[key])
            except (TypeError, ValueError):
                raise AccountError("Enter a whole number.") from None

        try:
            user = accounts.admin_update_user(user_id, add_searches=as_int("addSearches"), set_allowed=as_int("setAllowed"), status=body.get("status"))
        except AccountError as error:
            return fail(error.message, error.status)
        return ok({"user": user})

    @app.get("/api/admin/billing")
    def admin_billing(request: Request):
        _, denied = need_admin(request)
        if denied:
            return denied
        status = request.query_params.get("status")
        return ok({"requests": accounts.all_requests(status if status in ("pending", "approved", "rejected") else None)})

    @app.post("/api/admin/billing/{request_id}")
    async def admin_decide(request: Request, request_id: str):
        refused = reject_foreign_request(request)
        if refused:
            return refused
        _, denied = need_admin(request)
        if denied:
            return denied
        body = await json_body(request, {}) or {}
        searches = body.get("searches")
        try:
            searches = None if searches in (None, "") else int(searches)
            decided = accounts.decide_request(request_id, body.get("approve") is True, searches, str(body.get("note") or ""))
        except (TypeError, ValueError):
            return fail("Searches to give must be a whole number.")
        except AccountError as error:
            return fail(error.message, error.status)
        return ok({"request": decided})

    @app.get("/api/admin/plans")
    def admin_plans(request: Request):
        _, denied = need_admin(request)
        if denied:
            return denied
        return ok({"plans": accounts.list_plans(include_inactive=True)})

    @app.put("/api/admin/plans/{plan_id}")
    async def admin_update_plan(request: Request, plan_id: str):
        refused = reject_foreign_request(request)
        if refused:
            return refused
        _, denied = need_admin(request)
        if denied:
            return denied
        body = await json_body(request, {}) or {}
        try:
            plan = accounts.update_plan(plan_id, body)
        except AccountError as error:
            return fail(error.message, error.status)
        return ok({"plan": plan})

    # ===== SerpAPI (admin only) =====

    @app.get("/api/settings/serpapi")
    def serpapi_get(request: Request):
        _, denied = need_admin(request)
        if denied:
            return denied
        from .search.serpapi import serp_overview

        return ok(serp_overview())

    @app.put("/api/settings/serpapi")
    async def serpapi_put(request: Request):
        refused = reject_foreign_request(request)
        if refused:
            return refused
        _, denied = need_admin(request)
        if denied:
            return denied
        from .search.serpapi import clear_serp_key_sticky, serp_overview

        body = await json_body(request, None) or {}
        active = body.get("active") if body.get("active") in (1, 2) and not isinstance(body.get("active"), bool) else None
        auto = body.get("auto") if isinstance(body.get("auto"), bool) else None
        if active is None and auto is None:
            return fail("Choose a key or the automatic switch.")
        keys = config.serp_api_keys()
        if active and not keys[active - 1]:
            return fail(f"Key {active} is not set. Add it in backend/.env and restart the app.")
        settings.save_serp_preference(active=active, auto=auto)
        clear_serp_key_sticky()
        return ok(await run_in_threadpool(serp_overview))

    # ===== Status and jobs =====

    @app.get("/api/status")
    def status(request: Request):
        user = current_user(request)
        if not user:
            # Health check for the frontend and the tests. Nothing private.
            return ok({"ok": True, "signedIn": False})
        bind_workspace(user)
        scope = workspace(user)
        from .search.serpapi import serp_plan
        from .shopify.client import missing_shopify_settings

        totals = repo.usage_totals(scope)
        recent = [
            {"id": job["id"], "name": job["product_name"] or "Product", "aiUsd": price_usage(job["usage"])["aiUsd"]}
            for job in repo.list_recent_jobs(30, scope)
            if job["usage"]["aiInput"] > 0 or job["usage"]["aiOutput"] > 0
        ][:3]
        is_admin = user["role"] == "admin"
        account_info = None if is_admin else accounts.user_overview(user["id"])["user"]
        return ok({
            "signedIn": True,
            "role": user["role"],
            "account": account_info,
            "counts": repo.count_by_stage(scope),
            "listing": repo.listing_split(scope),
            "totals": {"requests": totals["requests"], "shopifyDrafts": totals["shopifyDrafts"], "cost": price_usage(totals["usage"])},
            "recentGpt": recent,
            "ai": ai_status(),
            "shopifyMissing": missing_shopify_settings(),
            "serpapi": bool(config.serp_api_key()),
            "serpPlan": serp_plan() if is_admin else None,
            "fastmoss": bool(settings.fastmoss_api_key()),
            "model": config.openai_model() if config.ai_provider() == "openai" else config.ai_model(),
        })

    @app.get("/api/jobs")
    def jobs(request: Request):
        user, denied = need_user(request)
        if denied:
            return denied
        return ok({"jobs": [{**job, "cost": price_usage(job["usage"])} for job in repo.list_recent_jobs(30, workspace(user))]})

    # ===== Products =====

    @app.get("/api/products")
    def products_list(request: Request):
        user, denied = need_user(request)
        if denied:
            return denied
        raw = request.query_params.get("stages")
        stages = [s for s in raw.split(",") if s in ALL_STAGES] if raw else ALL_STAGES
        if not stages:
            return fail("Unknown stage")
        scope = workspace(user)
        items = []
        for product in repo.list_products(stages, scope):
            item = {**product, "image_count": sum(1 for i in repo.list_images(product["id"]) if i["selected"])}
            item.pop("source_text", None)
            items.append(item)
        return ok({"products": items, "counts": repo.count_by_stage(scope)})

    @app.post("/api/products")
    async def products_create(request: Request):
        refused = reject_foreign_request(request)
        if refused:
            return refused
        user, denied = need_user(request)
        if denied:
            return denied
        content_type = request.headers.get("content-type") or ""
        if "multipart/form-data" not in content_type:
            return fail("Expected a form upload")

        product_id = str(uuid.uuid4())
        product_dir = os.path.join(config.storage_dir(), product_id)

        def cleanup():
            shutil.rmtree(product_dir, ignore_errors=True)

        try:
            form = await request.form(max_files=LIMITS.upload_images + 50, max_fields=100, max_part_size=1024 * 1024)
        except Exception as error:  # noqa: BLE001
            return fail(str(error) or "The upload failed.")

        fields: dict[str, str] = {}
        saved: list[dict] = []
        error_message: str | None = None
        try:
            for key, value in form.multi_items():
                if isinstance(value, UploadFile):
                    if not value.filename:
                        continue
                    mime = (value.content_type or "").lower()
                    is_video = mime in VIDEO_TYPES or bool(VIDEO_EXT.search(value.filename or ""))
                    is_image = mime.startswith("image/")
                    if not is_video and not is_image:
                        error_message = "Upload an image, or an MP4, MOV or WEBM video."
                        continue
                    if len(saved) >= LIMITS.upload_images + 1:
                        error_message = f"You can add up to {LIMITS.upload_images} images."
                        continue
                    kind = "videos" if is_video else "images"
                    tmp = temp_path(product_id, kind)
                    limit = LIMITS.video_max_bytes
                    size = 0
                    with open(tmp, "wb") as out:
                        while True:
                            chunk = await value.read(1024 * 1024)
                            if not chunk:
                                break
                            size += len(chunk)
                            if size > limit:
                                error_message = "That file is larger than the 1 GB limit." if is_video else "Images can be at most 20 MB."
                                break
                            out.write(chunk)
                    video_ext = None
                    if is_video:
                        match = VIDEO_EXT.search(value.filename or "")
                        video_ext = VIDEO_TYPES.get(mime) or (match.group(1).lower() if match else "mp4")
                    saved.append({"tmp": tmp, "kind": "video" if is_video else "image", "videoExt": video_ext})
                else:
                    fields[key] = str(value)
        finally:
            await form.close()

        if error_message:
            cleanup()
            return fail(error_message)

        name = (fields.get("name") or "").strip()[:300] or None
        details = (fields.get("details") or "").strip() or None
        if details and (len(details) < 8 or len(details) > 4000):
            cleanup()
            return fail("Product details must be between 8 and 4000 characters, or left empty.")
        urls, invalid = parse_url_list(fields.get("urls"))
        if invalid:
            cleanup()
            return fail(f"These are not valid web addresses: {', '.join(invalid)}")
        image_files = [f for f in saved if f["kind"] == "image"]
        video_files = [f for f in saved if f["kind"] == "video"]
        if len(video_files) > 1:
            cleanup()
            return fail("Only one video can be added.")
        if len(image_files) > LIMITS.upload_images:
            cleanup()
            return fail(f"You can add up to {LIMITS.upload_images} images.")
        if not saved and not name:
            cleanup()
            return fail("Enter a product name, or upload an image or video.")

        def store_files():
            from .media.images import convert_upload

            images: list[str] = []
            for file in image_files:
                if os.path.getsize(file["tmp"]) > LIMITS.image_max_bytes:
                    raise AccountError("Images can be at most 20 MB.")
                ext, converted = convert_upload(file["tmp"])
                if converted:
                    remove_quietly(file["tmp"])
                    images.append(commit_file(product_id, "images", converted, ext))
                else:
                    images.append(commit_file(product_id, "images", file["tmp"], ext))
            video = commit_file(product_id, "videos", video_files[0]["tmp"], video_files[0]["videoExt"] or "mp4") if video_files else None
            return images, video

        try:
            images, video = await run_in_threadpool(store_files)
        except AccountError as error:
            cleanup()
            return fail(error.message)
        except Exception:  # noqa: BLE001
            cleanup()
            return fail("That file could not be read as an image.")

        owner = workspace(user)
        # One search per product. The admin has no limit.
        if owner is not None:
            try:
                await run_in_threadpool(accounts.consume_search, owner, product_id)
            except AccountError as error:
                cleanup()
                return fail(error.message, error.status)

        def create():
            return repo.create_product_with_job(
                id=product_id, name=name, details=details, image=images[0] if images else None, images=images,
                video=video, urls=urls, search_photos=fields.get("search_photos") != "0",
                search_videos=fields.get("search_videos") != "0", owner_id=owner,
            )

        try:
            created = await run_in_threadpool(create)
        except Exception:  # noqa: BLE001
            traceback.print_exc()
            cleanup()
            try:
                db.execute("DELETE FROM products WHERE id = ?", (product_id,))
            except Exception:  # noqa: BLE001
                pass
            if owner is not None:
                await run_in_threadpool(accounts.refund_search, owner, product_id)
            return fail("The search could not be started. Try again.")
        try:
            # With Bunny the uploads are kept there at once, so a server that stops before research
            # runs cannot lose them. Research copies them back when it starts.
            await run_in_threadpool(publish_files, product_id)
        except Exception as error:  # noqa: BLE001
            print(f"[bunny] uploads of {product_id} stay on this server for now: {error}")
        if config.on_vercel():
            from .queue import drain_queue

            _in_background(drain_queue)
        return ok(created, 201)

    @app.get("/api/products/{product_id}")
    def product_get(request: Request, product_id: str):
        user, denied = need_user(request)
        if denied:
            return denied
        product = owned_product(user, product_id)
        if not product:
            return fail("Product not found", 404)
        return ok({
            "product": product,
            "images": repo.list_images(product_id),
            "videos": repo.list_videos(product_id),
            "sources": [{k: v for k, v in s.items() if k != "text"} for s in repo.list_sources(product_id)],
            "job": repo.latest_job(product_id),
        })

    @app.patch("/api/products/{product_id}")
    async def product_patch(request: Request, product_id: str):
        refused = reject_foreign_request(request)
        if refused:
            return refused
        user, denied = need_user(request)
        if denied:
            return denied
        product = owned_product(user, product_id)
        if not product:
            return fail("Product not found", 404)
        if product["stage"] != "listing":
            return fail("Only products in the Listing tab can be edited here.", 409)
        if product["shopify_product_id"]:
            return fail("This product is already in Shopify. Edit the draft there.", 409)
        if product["shopify_status"] == "sending":
            return fail("This product is being sent to Shopify. Try again when that finishes.", 409)
        body = await json_body(request, None)
        if not isinstance(body, dict):
            return fail("Invalid request")

        def pick(key):
            value = body.get(key)
            return value if value is not None else product.get(key)

        name = str(pick("name") or "").strip()
        sku = str(pick("sku") or "").strip()
        price = str(pick("price") or "").strip()
        cost = str(pick("cost") or "").strip()
        if not name:
            return fail("The product needs a name.")
        if not re.match(r"^[A-Za-z0-9._\-/]{1,64}$", sku):
            return fail("SKU can use letters, numbers, dots, dashes, underscores and slashes.")
        if repo.sku_taken_by_other(product_id, sku):
            return fail(f"SKU {sku} is already used by another product.")
        if price and not MONEY.match(price):
            return fail("Selling price must be a number like 19.99.")
        if cost and not MONEY.match(cost):
            return fail("Cost price must be a number like 7.50.")
        if body.get("imageIds") is not None:
            allowed = {i["id"] for i in repo.list_images(product_id) if i["selected"]}
            if not all(i in allowed for i in body["imageIds"]):
                return fail("Unknown image.")
            repo.set_image_order(product_id, body["imageIds"])
        if body.get("videoIds") is not None:
            allowed = {v["id"] for v in repo.list_videos(product_id) if v["selected"]}
            if not all(v in allowed for v in body["videoIds"]):
                return fail("Unknown video.")
            repo.set_video_order(product_id, body["videoIds"])
        repo.update_product(product_id, {
            "name": name,
            "sku": sku,
            "category": str(pick("category") or "").strip() or None,
            "description": body["description"] if body.get("description") is not None else product["description"],
            "price": price or None,
            "cost": cost or None,
        })
        return ok({"product": repo.get_product(product_id)})

    @app.post("/api/products/{product_id}/approve")
    async def product_approve(request: Request, product_id: str):
        refused = reject_foreign_request(request)
        if refused:
            return refused
        user, denied = need_user(request)
        if denied:
            return denied
        product = owned_product(user, product_id)
        if not product:
            return fail("Product not found", 404)
        # A review that moved to History because a newer product finished can still be approved.
        if product["stage"] not in ("review", "history"):
            return fail("Only products in the Review tab or in History can be approved.", 409)
        body = await json_body(request, None)
        if not isinstance(body, dict):
            return fail("Invalid request")
        name = str(body.get("name") or "").strip()
        if not name:
            return fail("The product needs a name.")
        image_ids = body.get("imageIds") or []
        video_ids = body.get("videoIds") or []
        images = {i["id"]: i for i in repo.list_images(product_id)}
        if not all((images.get(i) or {}).get("file_name") for i in image_ids):
            return fail("One of the selected images has no file.")
        videos = {v["id"]: v for v in repo.list_videos(product_id)}
        if not all((videos.get(v) or {}).get("file_name") or (videos.get(v) or {}).get("kind") == "link" for v in video_ids):
            return fail("One of the selected videos has no file.")
        repo.set_image_order(product_id, image_ids)
        repo.set_video_order(product_id, video_ids)
        repo.update_product(product_id, {
            "name": name,
            "category": str(body.get("category") if body.get("category") is not None else (product.get("category") or "")).strip() or None,
            "description": body["description"] if body.get("description") is not None else product["description"],
            "stage": "listing",
            "sku": product["sku"] or repo.next_sku(),
            "shopify_status": "ready",
        })
        approved = repo.get_product(product_id)

        def write_story():
            from .story import ensure_product_story

            try:
                ensure_product_story(product_id, approved.get("name") or "", approved.get("description") or "")
            except Exception as error:  # noqa: BLE001
                print(f"[story] could not write the page text for {product_id}: {error}")

        _in_background(write_story)
        return ok({"product": approved})

    @app.post("/api/products/{product_id}/reject")
    async def product_reject(request: Request, product_id: str):
        refused = reject_foreign_request(request)
        if refused:
            return refused
        user, denied = need_user(request)
        if denied:
            return denied
        product = owned_product(user, product_id)
        if not product:
            return fail("Product not found", 404)
        if product["stage"] not in ("review", "history"):
            return fail("Only products in the Review tab or in History can be rejected.", 409)
        repo.update_product(product_id, {"stage": "rejected"})
        return ok({"product": repo.get_product(product_id)})

    _research_lock = threading.Lock()

    @app.post("/api/products/{product_id}/research")
    async def product_research(request: Request, product_id: str):
        refused = reject_foreign_request(request)
        if refused:
            return refused
        user, denied = need_user(request)
        if denied:
            return denied
        body = await json_body(request, {}) or {}
        from .web.urls import normalize_url

        with _research_lock:
            product = owned_product(user, product_id)
            if not product:
                return fail("Product not found", 404)
            if product["stage"] not in ("review", "history", "rejected", "failed", "blocked"):
                return fail("This product cannot be researched again from its current stage.", 409)
            if repo.has_active_job(product_id):
                return fail("Research is already running for this product.", 409)
            urls, invalid = parse_url_list(body.get("urls"))
            if invalid:
                return fail(f"These are not valid web addresses: {', '.join(invalid)}")
            was_blocked = product["stage"] == "blocked"
            if was_blocked and not urls:
                return fail("Paste at least one product page URL to continue.")
            pasted = {normalize_url(u) for u in urls}
            repo.update_product(product_id, {
                "stage": "researching",
                "input_urls": list(dict.fromkeys([*product["input_urls"], *urls])),
                "blocked_urls": [u for u in product["blocked_urls"] if normalize_url(u) not in pasted],
            })
            job = repo.enqueue_job(product_id, was_blocked)
        if config.on_vercel():
            from .queue import drain_queue

            _in_background(drain_queue)
        return ok({"job": job}, 202)

    @app.post("/api/products/{product_id}/send")
    async def product_send(request: Request, product_id: str):
        refused = reject_foreign_request(request)
        if refused:
            return refused
        user, denied = need_user(request)
        if denied:
            return denied
        if not owned_product(user, product_id):
            return fail("Product not found", 404)
        body = await json_body(request, None) or {}
        from .shopify.send import start_send

        result = await run_in_threadpool(start_send, product_id, body.get("update") is True)
        if not result["started"]:
            return fail(result["reason"], result["status"])
        return ok({"product": repo.get_product(product_id)}, 202)

    @app.post("/api/products/{product_id}/story")
    async def product_story(request: Request, product_id: str):
        refused = reject_foreign_request(request)
        if refused:
            return refused
        user, denied = need_user(request)
        if denied:
            return denied
        if not owned_product(user, product_id):
            return fail("Product not found", 404)
        body = await json_body(request, None) or {}
        name = str(body.get("name") or "").strip()[:300]
        description = str(body.get("description") or "").strip()[:8000]
        if not name and not description:
            return fail("Add a product name or description first.")
        from .story import ensure_product_story

        try:
            return ok(await run_in_threadpool(ensure_product_story, product_id, name, description, body.get("refresh") is True))
        except AiError as error:
            return fail(str(error), 502)

    # ===== Files =====

    file_types = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm"}

    @app.get("/api/files/{product_id}/{kind}/{name}")
    def files(request: Request, product_id: str, kind: str, name: str):
        """Stored media, with Range support so videos can seek."""
        user = current_user(request)
        if not user or not is_safe_kind(kind):
            return fail("Not found", 404)
        if not owned_product(user, product_id):
            return fail("Not found", 404)
        try:
            file = media_path(product_id, kind, name)
        except ValueError:
            return fail("Not found", 404)
        kind_type = file_types.get(os.path.splitext(name)[1].lower())
        if not kind_type:
            return fail("Not found", 404)
        if not os.path.isfile(file):
            # Files that are on Bunny are shown from its CDN.
            cdn = public_url(product_id, kind, name)
            if not cdn:
                return fail("Not found", 404)
            return Response(status_code=302, headers={"location": cdn, "cache-control": "private, max-age=300"})
        size = os.path.getsize(file)
        headers = {
            "content-type": kind_type,
            "accept-ranges": "bytes",
            "x-content-type-options": "nosniff",
            "content-security-policy": "sandbox; default-src 'none'",
            "cache-control": "private, max-age=3600",
        }
        match = re.match(r"^bytes=(\d*)-(\d*)$", request.headers.get("range") or "")
        if match and (match.group(1) or match.group(2)):
            start = int(match.group(1)) if match.group(1) else max(0, size - int(match.group(2)))
            end = min(int(match.group(2)), size - 1) if match.group(1) and match.group(2) else size - 1
            if start >= size or start > end:
                return Response(status_code=416, headers={"content-range": f"bytes */{size}"})
            return StreamingResponse(_read_range(file, start, end), status_code=206, headers={**headers, "content-length": str(end - start + 1), "content-range": f"bytes {start}-{end}/{size}"})
        return StreamingResponse(_read_range(file, 0, size - 1), headers={**headers, "content-length": str(size)})

    @app.get("/api/public-photo/{product_id}/{file}")
    def public_photo(product_id: str, file: str):
        """The one route a public tunnel may reach. Serves one product's uploaded photo to Google Lens."""
        token = re.sub(r"\.jpg$", "", file, flags=re.I)
        if not settings.photo_token_valid(product_id, token):
            return fail("Not found", 404)
        product = repo.get_product(product_id)
        if not product or not product.get("input_image"):
            return fail("Not found", 404)
        try:
            from PIL import Image

            from .media.images import _flatten

            with Image.open(ensure_local(product_id, "images", product["input_image"])) as image:
                img = _flatten(image)
                img.thumbnail((1600, 1600), Image.LANCZOS)
                out = io.BytesIO()
                img.save(out, "JPEG", quality=88)
                data = out.getvalue()
        except Exception:  # noqa: BLE001
            return fail("Not found", 404)
        return Response(data, headers={"content-type": "image/jpeg", "content-length": str(len(data)), "cache-control": "private, max-age=600", "x-content-type-options": "nosniff"})

    # ===== Shopify settings =====

    def store_form(body: dict, *, have_secret: bool, have_token: bool):
        """The details of one store from the form. Returns (fields, None) or (None, the problem to show)."""
        method = "token" if body.get("method") == "token" else "client"
        domain = settings.normalize_domain(str(body.get("domain") or ""))
        client_id = str(body.get("clientId") or "").strip()
        client_secret = str(body.get("clientSecret") or "").strip()
        admin_token = str(body.get("adminToken") or "").strip()
        if not domain:
            return None, "Enter your store domain, for example my-store.myshopify.com."
        if not settings.is_valid_domain(domain):
            return None, f'"{domain}" does not look like a store domain. Use the form my-store.myshopify.com.'
        if method == "token":
            problem = _admin_token_problem(admin_token)
            if problem:
                return None, problem
            if not admin_token and not have_token:
                return None, "Enter the Admin API access token from your Shopify app. It starts with shpat_."
        else:
            if not client_id:
                return None, "Enter the Client ID from your Shopify app."
            if not client_secret and not have_secret:
                return None, "Enter the Client secret from your Shopify app."
        return (method, domain, client_id, client_secret, admin_token), None

    def stores_payload(user: dict) -> dict:
        """The stores of this account, which one is active, and how many the plan allows."""
        if user["role"] == "admin":
            summary = settings.shopify_summary()
            rows = [{"id": "admin", "domain": summary["domain"], "method": summary["method"], "clientId": summary["clientId"], "hasSecret": summary["hasSecret"], "hasAdminToken": summary["hasAdminToken"], "active": True, "createdAt": ""}] if summary["domain"] else []
            return {"stores": rows, "limit": None, "used": len(rows), "canAdd": False, "planName": None, "admin": True}
        owner = user["id"]
        rows = settings.list_stores(owner)
        active = settings.active_store(owner)
        allowance = accounts.store_allowance(owner)
        return {
            "stores": [settings.public_store(row, active["id"] if active else None) for row in rows],
            "limit": allowance["limit"],
            "used": len(rows),
            "canAdd": len(rows) < allowance["limit"],
            "planName": allowance["planName"],
            "admin": False,
        }

    @app.get("/api/stores")
    def stores_list(request: Request):
        user, denied = need_user(request)
        if denied:
            return denied
        return ok(stores_payload(user))

    @app.post("/api/stores")
    async def stores_add(request: Request):
        refused = reject_foreign_request(request)
        if refused:
            return refused
        user, denied = need_user(request)
        if denied:
            return denied
        if user["role"] == "admin":
            return fail("The admin connects the one store on the Integrations page.", 403)
        body = await json_body(request, None) or {}
        form, problem = store_form(body, have_secret=False, have_token=False)
        if problem:
            return fail(problem)
        method, domain, client_id, client_secret, admin_token = form
        owner = user["id"]
        allowance = accounts.store_allowance(owner)
        if len(settings.list_stores(owner)) >= allowance["limit"]:
            plan = f"Your {allowance['planName']} plan" if allowance["planName"] else "Your free account"
            return fail(f"{plan} allows {allowance['limit']} store{'s' if allowance['limit'] != 1 else ''}. Choose a bigger plan on the Billing page to connect more.", 403)
        try:
            row = settings.add_store(owner, method=method, domain=domain, client_id=client_id, client_secret=client_secret, admin_token=admin_token)
            settings.activate_store(owner, row["id"])
        except settings.StoreError as error:
            return fail(error.message, error.status)
        return ok(stores_payload(user), 201)

    @app.put("/api/stores/{store_id}")
    async def stores_update(request: Request, store_id: str):
        refused = reject_foreign_request(request)
        if refused:
            return refused
        user, denied = need_user(request)
        if denied:
            return denied
        if user["role"] == "admin":
            return fail("The admin changes the one store on the Integrations page.", 403)
        owner = user["id"]
        row = settings.get_store(owner, store_id)
        if not row:
            return fail("Store not found.", 404)
        body = await json_body(request, None) or {}
        form, problem = store_form(body, have_secret=bool(row["client_secret"]), have_token=bool(row["admin_token"]))
        if problem:
            return fail(problem)
        method, domain, client_id, client_secret, admin_token = form
        from .shopify.client import clear_token_cache

        try:
            settings.update_store(owner, store_id, method=method, domain=domain, client_id=client_id, client_secret=client_secret, admin_token=admin_token)
        except settings.StoreError as error:
            return fail(error.message, error.status)
        clear_token_cache()
        return ok(stores_payload(user))

    @app.delete("/api/stores/{store_id}")
    async def stores_remove(request: Request, store_id: str):
        refused = reject_foreign_request(request)
        if refused:
            return refused
        user, denied = need_user(request)
        if denied:
            return denied
        if user["role"] == "admin":
            return fail("The admin removes the store on the Integrations page.", 403)
        from .shopify.client import clear_token_cache

        try:
            settings.remove_store(user["id"], store_id)
        except settings.StoreError as error:
            return fail(error.message, error.status)
        clear_token_cache()
        return ok(stores_payload(user))

    @app.post("/api/stores/{store_id}/activate")
    async def stores_activate(request: Request, store_id: str):
        refused = reject_foreign_request(request)
        if refused:
            return refused
        user, denied = need_user(request)
        if denied:
            return denied
        if user["role"] == "admin":
            return fail("The admin has one store.", 403)
        try:
            settings.activate_store(user["id"], store_id)
        except settings.StoreError as error:
            return fail(error.message, error.status)
        return ok(stores_payload(user))

    @app.post("/api/stores/{store_id}/test")
    async def stores_test(request: Request, store_id: str):
        refused = reject_foreign_request(request)
        if refused:
            return refused
        user, denied = need_user(request)
        if denied:
            return denied
        if user["role"] == "admin" or not settings.get_store(user["id"], store_id):
            return fail("Store not found.", 404)
        from .shopify.client import ShopifyError, test_shopify_connection

        settings.current_store.set(store_id)
        try:
            return ok(await run_in_threadpool(test_shopify_connection))
        except ShopifyError as error:
            return fail(str(error), 422)
        except Exception as error:  # noqa: BLE001
            return fail(str(error), 500)

    @app.get("/api/settings/shopify")
    def shopify_get(request: Request):
        _, denied = need_user(request)
        if denied:
            return denied
        return ok(settings.shopify_summary())

    @app.put("/api/settings/shopify")
    async def shopify_put(request: Request):
        refused = reject_foreign_request(request)
        if refused:
            return refused
        _, denied = need_user(request)
        if denied:
            return denied
        from .shopify.client import clear_token_cache

        body = await json_body(request, None) or {}
        creds = settings.shopify_credentials()
        form, problem = store_form(body, have_secret=bool(creds["clientSecret"]), have_token=bool(creds["adminToken"]))
        if problem:
            return fail(problem)
        method, domain, client_id, client_secret, admin_token = form
        settings.save_shopify_credentials(method=method, domain=domain, client_id=client_id, client_secret=client_secret, admin_token=admin_token)
        clear_token_cache()
        return ok(settings.shopify_summary())

    @app.delete("/api/settings/shopify")
    async def shopify_delete(request: Request):
        refused = reject_foreign_request(request)
        if refused:
            return refused
        _, denied = need_user(request)
        if denied:
            return denied
        from .shopify.client import clear_token_cache

        settings.clear_shopify_credentials()
        clear_token_cache()
        return ok(settings.shopify_summary())

    @app.post("/api/settings/shopify/test")
    async def shopify_test(request: Request):
        refused = reject_foreign_request(request)
        if refused:
            return refused
        _, denied = need_user(request)
        if denied:
            return denied
        from .shopify.client import ShopifyError, test_shopify_connection

        try:
            return ok(await run_in_threadpool(test_shopify_connection))
        except ShopifyError as error:
            return fail(str(error), 422)
        except Exception as error:  # noqa: BLE001
            return fail(str(error), 500)

    # ===== Templates =====

    @app.get("/api/templates")
    def templates_list(request: Request):
        _, denied = need_user(request)
        if denied:
            return denied
        from .shopify.client import missing_shopify_settings
        from .shopify.theme import is_theme_push_running
        from .templates import THEME_TEMPLATES, template_size

        domain = settings.shopify_credentials()["domain"]
        chosen = settings.default_template_id()
        items = []
        for template in THEME_TEMPLATES:
            last = settings.last_template_push(template["id"])
            last = last if last and last.get("domain") == domain else None
            items.append({**template, **template_size(template["id"]), "lastPush": last, "useForNew": template["id"] == chosen})
        return ok({"store": {"domain": domain, "missing": missing_shopify_settings()}, "running": is_theme_push_running(), "templates": items})

    @app.post("/api/templates/{template_id}/use")
    async def template_use(request: Request, template_id: str):
        """Products pushed from now on, to the active store, get this page. Products already there keep theirs."""
        refused = reject_foreign_request(request)
        if refused:
            return refused
        _, denied = need_user(request)
        if denied:
            return denied
        from .templates import find_template

        if not find_template(template_id):
            return fail("Unknown template.", 404)
        last = settings.last_template_push(template_id)
        if not last or last.get("domain") != settings.shopify_credentials()["domain"]:
            return fail("Add this page to your store first. Then you can choose it for new products.", 409)
        settings.save_default_template(template_id)
        return ok({"templateId": template_id})

    @app.post("/api/templates/{template_id}/push")
    async def template_push(request: Request, template_id: str):
        refused = reject_foreign_request(request)
        if refused:
            return refused
        _, denied = need_user(request)
        if denied:
            return denied
        from .shopify.client import ShopifyError
        from .shopify.theme import is_theme_push_running, push_theme_template
        from .templates import find_template

        template = find_template(template_id)
        if not template:
            return fail("Template not found.", 404)
        if is_theme_push_running():
            return fail("A theme push is already running. Wait for it to finish.", 409)

        import queue as queue_module

        lines: queue_module.Queue = queue_module.Queue()
        context = contextvars.copy_context()

        def work():
            try:
                result = push_theme_template(template, lambda step: lines.put({"type": "progress", "step": step}))
                lines.put({"type": "done", "result": result})
            except Exception as error:  # noqa: BLE001
                if not isinstance(error, ShopifyError):
                    traceback.print_exc()
                lines.put({"type": "error", "message": str(error)})
            finally:
                lines.put(None)

        threading.Thread(target=lambda: context.run(work), daemon=True).start()

        async def stream():
            while True:
                item = await run_in_threadpool(lines.get)
                if item is None:
                    break
                yield (json.dumps(item) + "\n").encode()

        return StreamingResponse(stream(), headers={"content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no"})

    # ===== Find Creatives =====

    @app.post("/api/creatives/find")
    async def creatives_find(request: Request):
        refused = reject_foreign_request(request)
        if refused:
            return refused
        _, denied = need_user(request)
        if denied:
            return denied
        from .creatives import CreativeError, find_creatives

        try:
            query = await _creative_query(request)
            return ok(await run_in_threadpool(lambda: find_creatives(**query)))
        except CreativeError as error:
            return fail(error.message, error.status)
        except AiError as error:
            return fail(str(error), 502)
        except Exception as error:  # noqa: BLE001
            print("[creatives]", error)
            return fail("The search failed. Try again.", 500)

    return app


def _read_range(path: str, start: int, end: int):
    with open(path, "rb") as handle:
        handle.seek(start)
        left = end - start + 1
        while left > 0:
            chunk = handle.read(min(256 * 1024, left))
            if not chunk:
                break
            left -= len(chunk)
            yield chunk


def _admin_token_problem(token: str) -> str | None:
    if not token:
        return None
    if re.search(r"\s", token):
        return "The Admin token cannot contain spaces. Copy it again from Shopify."
    if token.startswith("shpss_"):
        return "That is the app's API secret key, not the Admin API access token. The access token starts with shpat_."
    if len(token) > 255:
        return "That is too long to be an Admin API access token. Copy it again from Shopify."
    return None


def _flag(value, fallback: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        if value in ("0", "false"):
            return False
        if value in ("1", "true"):
            return True
    return fallback


def _days(value) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return 180
    return parsed if parsed == parsed and parsed not in (float("inf"), float("-inf")) else 180


def _keywords_from(value: str | None) -> list[str] | None:
    if not value or not value.strip():
        return None
    try:
        parsed = json.loads(value)
    except ValueError:
        return value.split("\n")
    return [w for w in parsed if isinstance(w, str)] if isinstance(parsed, list) else None


async def _creative_query(request: Request) -> dict:
    from .creatives import CreativeError

    content_type = request.headers.get("content-type") or ""
    if "multipart/form-data" in content_type:
        form = await request.form(max_files=2, max_fields=50, max_part_size=8000)
        try:
            image = None
            for _key, value in form.multi_items():
                if isinstance(value, UploadFile) and value.filename:
                    if not (value.content_type or "").lower().startswith("image/"):
                        raise CreativeError("That file is not a readable image.")
                    if image is not None:
                        raise CreativeError("Upload one product image.")
                    data = await value.read(LIMITS.image_max_bytes + 1)
                    if len(data) > LIMITS.image_max_bytes:
                        raise CreativeError("Images can be at most 20 MB.")
                    image = data

            def text(key):
                value = form.get(key)
                return value if isinstance(value, str) else None

            return {
                "image": image,
                "image_url": text("imageUrl"),
                "title": text("title") or "",
                "brand": text("brand") or "",
                "model": text("model") or "",
                "color": text("color") or "",
                "packaging_text": text("packagingText") or "",
                "keywords": _keywords_from(text("keywords")),
                "shorts_only": _flag(text("shortsOnly"), True),
                "days": _days(text("days")),
            }
        finally:
            await form.close()
    try:
        body = await request.json()
    except Exception as error:  # noqa: BLE001
        raise CreativeError("The request could not be read.") from error

    def text(key):
        value = body.get(key)
        return value if isinstance(value, str) else ""

    keywords = body.get("keywords")
    return {
        "image_url": body.get("imageUrl") if isinstance(body.get("imageUrl"), str) else None,
        "title": text("title"),
        "brand": text("brand"),
        "model": text("model"),
        "color": text("color"),
        "packaging_text": text("packagingText"),
        "keywords": [w for w in keywords if isinstance(w, str)] if isinstance(keywords, list) else None,
        "shorts_only": _flag(body.get("shortsOnly"), True),
        "days": _days(body.get("days")),
    }


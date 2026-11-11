"""Every read and write of products, jobs, sources, images and videos."""
from __future__ import annotations

import json
import threading
import uuid
from datetime import datetime, timedelta, timezone

from . import db
from .costs import EMPTY_USAGE, normalize_usage


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _parse(value, fallback):
    if not isinstance(value, str):
        return fallback
    try:
        return json.loads(value)
    except ValueError:
        return fallback


def to_product(row: dict) -> dict:
    product = dict(row)
    product["input_urls"] = _parse(row.get("input_urls"), [])
    names = _parse(row.get("input_images"), [])
    product["input_images"] = names if names else ([str(row["input_image"])] if row.get("input_image") else [])
    product["blocked_urls"] = _parse(row.get("blocked_urls"), [])
    product["vision"] = _parse(row.get("vision"), None)
    product["name_options"] = _parse(row.get("name_options"), [])
    product["claims"] = _parse(row.get("claims"), [])
    product["warnings"] = _parse(row.get("warnings"), [])
    product["shopify_warnings"] = _parse(row.get("shopify_warnings"), [])
    product["low_images"] = bool(row.get("low_images"))
    product["search_photos"] = True if row.get("search_photos") is None else bool(row["search_photos"])
    product["search_videos"] = True if row.get("search_videos") is None else bool(row["search_videos"])
    product.pop("owner_id", None)
    return product


def to_job(row: dict) -> dict:
    job = dict(row)
    job["log"] = _parse(row.get("log"), [])
    job["skip_search"] = bool(row.get("skip_search"))
    job["usage"] = normalize_usage(_parse(row.get("usage"), {}))
    return job


def to_image(row: dict) -> dict:
    image = dict(row)
    image["checks"] = _parse(row.get("checks"), {"minSize": False, "duplicate": False, "aiChecked": False})
    image["passed"] = bool(row.get("passed"))
    image["selected"] = bool(row.get("selected"))
    image["uploaded"] = bool(row.get("uploaded"))
    return image


def to_video(row: dict) -> dict:
    video = dict(row)
    video["passed"] = bool(row.get("passed"))
    video["selected"] = bool(row.get("selected"))
    video["uploaded"] = bool(row.get("uploaded"))
    return video


# ---------- Products ----------

def create_product_with_job(*, id: str, name, details=None, image=None, images=None, video=None, urls=(), search_photos=True, search_videos=True, owner_id=None) -> dict:
    stamp = now()
    with db.transaction() as connection:
        connection.execute(
            """INSERT INTO products (id, stage, input_name, input_details, input_image, input_images, input_video, input_urls, search_photos, search_videos, owner_id, created_at, updated_at)
               VALUES (?, 'researching', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                id, name, details, image,
                json.dumps(images if images else ([image] if image else [])),
                video, json.dumps(list(urls)),
                1 if search_photos is not False else 0,
                1 if search_videos is not False else 0,
                owner_id, stamp, stamp,
            ),
        )
        job = enqueue_job(id, False)
    return {"product": get_product(id), "job": job}


def get_product(product_id: str) -> dict | None:
    row = db.one("SELECT * FROM products WHERE id = ?", (product_id,))
    return to_product(row) if row else None


def product_owner(product_id: str) -> str | None:
    row = db.one("SELECT owner_id FROM products WHERE id = ?", (product_id,))
    return row["owner_id"] if row else None


ALL = "__all__"
"""Pass as owner_id to read every account's products (admin totals)."""


def _owner_clause(owner_id: str | None, column: str = "owner_id") -> tuple[str, list]:
    """None: the admin's own workspace (and listings made before accounts). ALL: everything. Else one user."""
    if owner_id == ALL:
        return "", []
    if owner_id is None:
        return f" AND {column} IS NULL", []
    return f" AND {column} = ?", [owner_id]


def list_products(stages: list[str], owner_id: str | None = ALL) -> list[dict]:
    marks = ",".join("?" * len(stages))
    clause, params = _owner_clause(owner_id)
    rows = db.all_rows(f"SELECT * FROM products WHERE stage IN ({marks}){clause} ORDER BY created_at DESC", [*stages, *params])
    return [to_product(row) for row in rows]


def archive_other_reviews(keep_id: str) -> None:
    """Finished reviews other than the one just completed move to History (for the same account)."""
    clause, params = _owner_clause(product_owner(keep_id))
    db.execute(f"UPDATE products SET stage = 'history', updated_at = ? WHERE stage = 'review' AND id != ?{clause}", (now(), keep_id, *params))


def count_by_stage(owner_id: str | None = ALL) -> dict:
    clause, params = _owner_clause(owner_id)
    rows = db.all_rows(f"SELECT stage, COUNT(*) AS n FROM products WHERE 1 = 1{clause} GROUP BY stage", params)
    return {row["stage"]: row["n"] for row in rows}


def listing_split(owner_id: str | None = ALL) -> dict:
    clause, params = _owner_clause(owner_id)
    row = db.one(
        f"""SELECT
             SUM(CASE WHEN shopify_product_id IS NULL THEN 1 ELSE 0 END) AS approved,
             SUM(CASE WHEN shopify_product_id IS NOT NULL THEN 1 ELSE 0 END) AS pushed
           FROM products WHERE stage = 'listing'{clause}""",
        params,
    )
    return {"approved": row["approved"] or 0, "pushed": row["pushed"] or 0}


JSON_FIELDS = {"input_urls", "blocked_urls", "vision", "name_options", "claims", "warnings", "shopify_warnings"}
PRODUCT_FIELDS = {
    "stage", "input_urls", "blocked_urls", "vision", "name", "name_options", "category", "description", "source_text", "claims",
    "seller_name", "low_images", "warnings", "sku", "price", "cost", "shopify_status", "shopify_product_id",
    "shopify_admin_url", "shopify_handle", "shopify_error", "shopify_warnings",
}


def update_product(product_id: str, fields: dict) -> None:
    for key in fields:
        if key not in PRODUCT_FIELDS:
            raise ValueError(f"Unknown product field: {key}")
    if not fields:
        return
    values = []
    for key, value in fields.items():
        if key in JSON_FIELDS:
            values.append(None if value is None else json.dumps(value))
        elif isinstance(value, bool):
            values.append(int(value))
        else:
            values.append(value)
    assignments = ", ".join(f"{key} = ?" for key in fields)
    db.execute(f"UPDATE products SET {assignments}, updated_at = ? WHERE id = ?", (*values, now(), product_id))


def reset_research(product_id: str) -> None:
    with db.transaction() as connection:
        connection.execute("DELETE FROM sources WHERE product_id = ?", (product_id,))
        connection.execute("DELETE FROM images WHERE product_id = ? AND uploaded = 0", (product_id,))
        connection.execute("DELETE FROM videos WHERE product_id = ? AND uploaded = 0", (product_id,))
        update_product(product_id, {
            "name": None, "name_options": [], "category": None, "description": None, "source_text": None, "claims": [],
            "seller_name": None, "low_images": False, "warnings": [],
        })


# ---------- Jobs ----------

def enqueue_job(product_id: str, skip_search: bool) -> dict:
    stamp = now()
    job_id = str(uuid.uuid4())
    with db.transaction() as connection:
        seq = connection.execute("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM jobs").fetchone()["seq"]
        connection.execute(
            """INSERT INTO jobs (id, seq, product_id, status, step, skip_search, created_at, updated_at)
               VALUES (?, ?, ?, 'QUEUED', 'Waiting in queue', ?, ?, ?)""",
            (job_id, seq, product_id, 1 if skip_search else 0, stamp, stamp),
        )
    return get_job(job_id)


def get_job(job_id: str) -> dict | None:
    row = db.one("SELECT * FROM jobs WHERE id = ?", (job_id,))
    return to_job(row) if row else None


def latest_job(product_id: str) -> dict | None:
    row = db.one("SELECT * FROM jobs WHERE product_id = ? ORDER BY seq DESC LIMIT 1", (product_id,))
    return to_job(row) if row else None


def list_recent_jobs(limit: int = 30, owner_id: str | None = ALL) -> list[dict]:
    clause, params = _owner_clause(owner_id, "p.owner_id")
    rows = db.all_rows(
        f"""SELECT j.*, COALESCE(p.name, p.input_name) AS product_name, p.stage AS product_stage,
                  p.search_photos AS search_photos, p.search_videos AS search_videos
           FROM jobs j JOIN products p ON p.id = j.product_id WHERE 1 = 1{clause} ORDER BY j.seq DESC LIMIT ?""",
        [*params, limit],
    )
    out = []
    for row in rows:
        job = to_job(row)
        job["product_name"] = row["product_name"]
        job["product_stage"] = row["product_stage"]
        job["search_photos"] = True if row.get("search_photos") is None else bool(row["search_photos"])
        job["search_videos"] = True if row.get("search_videos") is None else bool(row["search_videos"])
        out.append(job)
    return out


def usage_totals(owner_id: str | None = ALL) -> dict:
    clause, params = _owner_clause(owner_id, "p.owner_id")
    rows = db.all_rows(f"SELECT j.usage FROM jobs j JOIN products p ON p.id = j.product_id WHERE 1 = 1{clause}", params)
    clause, params = _owner_clause(owner_id)
    drafts = db.one(f"SELECT COUNT(*) AS n FROM products WHERE shopify_status = 'draft'{clause}", params)
    total = dict(EMPTY_USAGE)
    for row in rows:
        item = normalize_usage(_parse(row["usage"], {}))
        for key in total:
            total[key] += item[key]
    return {"requests": len(rows), "usage": total, "shopifyDrafts": drafts["n"]}


def set_usage(job_id: str, usage: dict) -> None:
    db.execute("UPDATE jobs SET usage = ? WHERE id = ?", (json.dumps(normalize_usage(usage)), job_id))


_usage_lock = threading.Lock()


def note_running_usage(delta: dict) -> None:
    """Adds to the job that is running now. Research runs one job at a time."""
    with _usage_lock:
        row = db.one("SELECT id, usage FROM jobs WHERE status = 'RUNNING' ORDER BY seq DESC LIMIT 1")
        if not row:
            return
        current = normalize_usage(_parse(row["usage"], {}))
        set_usage(row["id"], {key: current[key] + (delta.get(key) or 0) for key in current})


def empty_usage() -> dict:
    return dict(EMPTY_USAGE)


def has_active_job(product_id: str) -> bool:
    return bool(db.one("SELECT 1 AS x FROM jobs WHERE product_id = ? AND status IN ('QUEUED','RUNNING')", (product_id,)))


def claim_next_job() -> dict | None:
    """Atomically takes the oldest queued job. With several backends on one database, the status
    check in the outer WHERE makes sure only one of them gets it."""
    with db.transaction() as connection:
        row = connection.execute(
            """UPDATE jobs SET status = 'RUNNING', attempts = attempts + 1, updated_at = ?
               WHERE id = (SELECT id FROM jobs WHERE status = 'QUEUED' ORDER BY seq LIMIT 1) AND status = 'QUEUED'
               RETURNING *""",
            (now(),),
        ).fetchone()
        result = dict(row) if row else None
    return to_job(result) if result else None


def set_job_step(job_id: str, step: str) -> None:
    job = get_job(job_id)
    if not job:
        return
    stamp = now()
    log = json.dumps([*job["log"], {"at": stamp, "text": step}][-200:])
    db.execute("UPDATE jobs SET step = ?, log = ?, updated_at = ? WHERE id = ?", (step, log, stamp, job_id))


def finish_job(job_id: str, status: str, step: str, message: str | None) -> None:
    stamp = now()
    db.execute("UPDATE jobs SET status = ?, step = ?, message = ?, updated_at = ?, finished_at = ? WHERE id = ?", (status, step, message, stamp, stamp, job_id))


def minutes_ago(minutes: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def recover_jobs(max_attempts: int, idle_minutes: int = 0) -> None:
    """Jobs left RUNNING by a backend that stopped go back in the queue, unless retried too often.
    On a shared database another backend may be running a job right now, so only jobs with no
    progress for idle_minutes count as stopped. Each change applies only if the job is unchanged."""
    stamp = now()
    for row in db.all_rows("SELECT * FROM jobs WHERE status = 'RUNNING' AND updated_at <= ?", (minutes_ago(idle_minutes),)):
        job = to_job(row)
        unchanged = (job["id"], row["updated_at"])
        if job["attempts"] >= max_attempts:
            message = f"The app stopped during this job {job['attempts']} times, so it was not restarted again."
            cursor = db.execute(
                "UPDATE jobs SET status = 'FAILED', step = 'Stopped', message = ?, updated_at = ?, finished_at = ? WHERE id = ? AND status = 'RUNNING' AND updated_at = ?",
                (message, stamp, stamp, *unchanged),
            )
            if cursor.rowcount == 1:
                update_product(job["product_id"], {"stage": "failed"})
        else:
            log = [*job["log"], {"at": stamp, "text": "App restarted. Job returned to the queue."}]
            db.execute(
                "UPDATE jobs SET status = 'QUEUED', step = 'Waiting in queue (restarted)', log = ?, updated_at = ? WHERE id = ? AND status = 'RUNNING' AND updated_at = ?",
                (json.dumps(log), stamp, *unchanged),
            )


def has_running_work() -> bool:
    """True while research is waiting or running, or a product is being sent to Shopify."""
    return bool(
        db.one("SELECT 1 AS x FROM jobs WHERE status IN ('QUEUED', 'RUNNING') LIMIT 1")
        or db.one("SELECT 1 AS x FROM products WHERE shopify_status = 'sending' LIMIT 1")
    )


def recover_sends(idle_minutes: int = 0) -> None:
    """Sends left 'sending' by a backend that stopped. On a shared database only old ones count."""
    stamp = now()
    before = minutes_ago(idle_minutes)
    db.execute("UPDATE products SET shopify_status = 'draft', updated_at = ? WHERE shopify_status = 'sending' AND shopify_product_id IS NOT NULL AND updated_at <= ?", (stamp, before))
    db.execute(
        "UPDATE products SET shopify_status = 'error', shopify_error = ?, updated_at = ? WHERE shopify_status = 'sending' AND shopify_product_id IS NULL AND updated_at <= ?",
        ("The app stopped while sending. Click Retry. It checks Shopify first, so it will not create a duplicate.", stamp, before),
    )


# ---------- Sources ----------

def add_source(product_id: str, *, url: str, status: str, title=None, seller=None, reason=None, text=None) -> None:
    with db.transaction() as connection:
        seq = connection.execute("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM sources WHERE product_id = ?", (product_id,)).fetchone()["seq"]
        connection.execute(
            "INSERT INTO sources (id, product_id, url, title, seller, status, reason, text, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (str(uuid.uuid4()), product_id, url, title, seller, status, reason, text, seq),
        )


def list_sources(product_id: str) -> list[dict]:
    return db.all_rows("SELECT * FROM sources WHERE product_id = ? ORDER BY seq", (product_id,))


# ---------- Images ----------

def add_image(image: dict) -> dict:
    image_id = str(uuid.uuid4())
    db.execute(
        """INSERT INTO images (id, product_id, file_name, source_url, source_page, width, height, bytes, phash, passed, reason, checks, position, uploaded)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            image_id, image["product_id"], image.get("file_name"), image.get("source_url"), image.get("source_page"),
            image.get("width"), image.get("height"), image.get("bytes"), image.get("phash"),
            int(bool(image.get("passed"))), image.get("reason"), json.dumps(image.get("checks") or {}),
            image.get("position", 0), int(bool(image.get("uploaded"))),
        ),
    )
    return get_image(image_id)


def get_image(image_id: str) -> dict | None:
    row = db.one("SELECT * FROM images WHERE id = ?", (image_id,))
    return to_image(row) if row else None


def list_images(product_id: str) -> list[dict]:
    return [to_image(row) for row in db.all_rows("SELECT * FROM images WHERE product_id = ? ORDER BY position, " + db.insert_order(), (product_id,))]


def update_image_check(image_id: str, passed: bool, reason: str | None, checks: dict) -> None:
    db.execute("UPDATE images SET passed = ?, reason = ?, checks = ? WHERE id = ?", (int(passed), reason, json.dumps(checks), image_id))


def set_image_order(product_id: str, ordered_selected_ids: list[str]) -> None:
    with db.transaction() as connection:
        connection.execute("UPDATE images SET selected = 0 WHERE product_id = ?", (product_id,))
        for index, image_id in enumerate(ordered_selected_ids):
            connection.execute("UPDATE images SET selected = 1, position = ? WHERE id = ? AND product_id = ?", (index, image_id, product_id))


def rank_images(product_id: str, ordered_ids: list[str], selected_ids: list[str]) -> None:
    with db.transaction() as connection:
        for index, image_id in enumerate(ordered_ids):
            connection.execute("UPDATE images SET position = ?, selected = ? WHERE id = ? AND product_id = ?", (index, int(image_id in selected_ids), image_id, product_id))


# ---------- Videos ----------

def add_video(video: dict) -> dict:
    video_id = str(uuid.uuid4())
    with db.transaction() as connection:
        position = connection.execute("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM videos WHERE product_id = ?", (video["product_id"],)).fetchone()["position"]
        connection.execute(
            """INSERT INTO videos (id, product_id, kind, provider, url, file_name, source_page, bytes, passed, reason, selected, position, uploaded)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                video_id, video["product_id"], video["kind"], video.get("provider"), video.get("url"), video.get("file_name"),
                video.get("source_page"), video.get("bytes"), int(bool(video.get("passed"))), video.get("reason"),
                int(bool(video.get("selected"))), position, int(bool(video.get("uploaded"))),
            ),
        )
    return next(v for v in list_videos(video["product_id"]) if v["id"] == video_id)


def list_videos(product_id: str) -> list[dict]:
    return [to_video(row) for row in db.all_rows("SELECT * FROM videos WHERE product_id = ? ORDER BY position, " + db.insert_order(), (product_id,))]


def set_video_order(product_id: str, ordered_selected_ids: list[str]) -> None:
    with db.transaction() as connection:
        connection.execute("UPDATE videos SET selected = 0 WHERE product_id = ?", (product_id,))
        for index, video_id in enumerate(ordered_selected_ids):
            connection.execute("UPDATE videos SET selected = 1, position = ? WHERE id = ? AND product_id = ?", (index, video_id, product_id))


# ---------- Listing ----------

def next_sku() -> str:
    """The next free SKU, like PRD-0001. Numbers are never reused."""
    with db.transaction() as connection:
        while True:
            value = connection.execute(
                "INSERT INTO counters (name, value) VALUES ('sku', 1) ON CONFLICT(name) DO UPDATE SET value = counters.value + 1 RETURNING value"
            ).fetchone()["value"]
            sku = f"PRD-{value:04d}"
            if not connection.execute("SELECT 1 FROM products WHERE sku = ?", (sku,)).fetchone():
                return sku


def sku_taken_by_other(product_id: str, sku: str) -> bool:
    return bool(db.one("SELECT 1 AS x FROM products WHERE sku = ? AND id <> ?", (sku, product_id)))


def claim_for_update(product_id: str) -> bool:
    cursor = db.execute(
        """UPDATE products
           SET shopify_status = 'sending', shopify_error = NULL, shopify_warnings = '[]', updated_at = ?
           WHERE id = ? AND stage = 'listing' AND shopify_product_id IS NOT NULL AND shopify_status IN ('draft', 'error')""",
        (now(), product_id),
    )
    return cursor.rowcount == 1


def claim_for_sending(product_id: str, handle: str) -> bool:
    """The duplicate guard. A single conditional UPDATE, so only one caller can move a product into 'sending'."""
    cursor = db.execute(
        """UPDATE products
           SET shopify_status = 'sending', shopify_error = NULL, shopify_warnings = '[]',
               shopify_handle = COALESCE(shopify_handle, ?), updated_at = ?
           WHERE id = ? AND stage = 'listing' AND shopify_product_id IS NULL AND shopify_status IN ('ready', 'error')""",
        (handle, now(), product_id),
    )
    return cursor.rowcount == 1


def set_shopify_result(product_id: str, *, status: str, shopify_id=None, admin_url=None, error=..., warnings=None) -> None:
    fields: dict = {"shopify_status": status}
    if shopify_id is not None:
        fields["shopify_product_id"] = shopify_id
    if admin_url is not None:
        fields["shopify_admin_url"] = admin_url
    if error is not ...:
        fields["shopify_error"] = error
    if warnings is not None:
        fields["shopify_warnings"] = warnings
    update_product(product_id, fields)

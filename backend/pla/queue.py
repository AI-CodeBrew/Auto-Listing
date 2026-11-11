"""Background research queue. Jobs are rows in SQLite, so they survive a restart. One thread runs
one job at a time."""
from __future__ import annotations

import os
import threading
import time
import traceback

from . import repo
from .config import LIMITS

POLL_S = 0.5
# On a shared Postgres every poll is a trip over the internet, so it checks less often.
POLL_S_SHARED = 2.0
KEEP_AWAKE_S = 60
# Shared database: another backend may be working, so only work with no progress this long counts as stopped.
STALE_JOB_MINUTES = 10
STALE_SEND_MINUTES = 30
RECOVER_EVERY_S = 60
_started = False
_start_lock = threading.Lock()
_drain_lock = threading.Lock()


def _run_one(job: dict) -> None:
    from .ai import AiError
    from .pipeline.research import JobBlocked, run_research

    try:
        run_research(job)
        repo.finish_job(job["id"], "DONE", "Ready for review", None)
    except JobBlocked as error:
        product = repo.get_product(job["product_id"])
        fields: dict = {"stage": "blocked"}
        if product:
            fields["blocked_urls"] = list(dict.fromkeys([*product["blocked_urls"], *error.blocked_urls]))
        repo.update_product(job["product_id"], fields)
        repo.finish_job(job["id"], "BLOCKED", "Blocked", error.message)
    except Exception as error:  # noqa: BLE001
        message = str(error) if isinstance(error, (AiError, Exception)) else repr(error)
        print(f"[queue] job {job['id']} failed: {message}")
        traceback.print_exc()
        repo.update_product(job["product_id"], {"stage": "failed"})
        repo.finish_job(job["id"], "FAILED", "Failed", (message.split("\n")[0] or error.__class__.__name__)[:500])
    finally:
        try:
            from .web.browser import close_browser

            close_browser()
        except Exception:  # noqa: BLE001
            pass
        try:
            # With Bunny, the photos and videos this job found move there; the server keeps nothing.
            from .storage import publish_files

            publish_files(job["product_id"])
        except Exception as error:  # noqa: BLE001
            print(f"[bunny] files of {job['product_id']} stay on this server for now: {error}")


def _recover(shared: bool) -> None:
    repo.recover_jobs(LIMITS.job_max_attempts, STALE_JOB_MINUTES if shared else 0)
    repo.recover_sends(STALE_SEND_MINUTES if shared else 0)


def _loop() -> None:
    from . import db

    shared = db.is_postgres()
    last_recover = time.monotonic()
    while True:
        try:
            # A backend that stopped mid-job (a Fly machine going to sleep) leaves it RUNNING; any
            # backend on the shared database puts it back in the queue once it has been idle a while.
            if shared and time.monotonic() - last_recover >= RECOVER_EVERY_S:
                last_recover = time.monotonic()
                _recover(shared)
            job = repo.claim_next_job()
            if job:
                _run_one(job)
                continue
        except Exception:  # noqa: BLE001
            print("[queue] unexpected error")
            traceback.print_exc()
        time.sleep(POLL_S_SHARED if shared else POLL_S)


def start_worker() -> None:
    global _started
    with _start_lock:
        if _started:
            return
        _started = True
    from . import db

    _recover(db.is_postgres())
    threading.Thread(target=_loop, name="pla-queue", daemon=True).start()
    if os.environ.get("FLY_APP_NAME"):
        threading.Thread(target=_keep_awake, args=(os.environ["FLY_APP_NAME"],), name="pla-keep-awake", daemon=True).start()


def _keep_awake(app_name: str) -> None:
    """On Fly.io the machine is stopped when no requests reach it, to save money. While research or a
    Shopify send is running, one request a minute through Fly's proxy keeps it on until the work is done,
    even when nobody has the app open. Idle, it sends nothing, so Fly can stop it."""
    import httpx

    url = f"https://{app_name}.fly.dev/api/status"
    while True:
        time.sleep(KEEP_AWAKE_S)
        try:
            if repo.has_running_work():
                httpx.get(url, timeout=10)
        except Exception as error:  # noqa: BLE001
            print("[keep-awake]", error)


def drain_queue() -> None:
    """Runs queued jobs where there is no always-on loop (the deployed site)."""
    if not _drain_lock.acquire(blocking=False):
        return
    try:
        while True:
            job = repo.claim_next_job()
            if not job:
                return
            _run_one(job)
    finally:
        _drain_lock.release()

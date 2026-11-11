"""Copies everything the backend kept on this computer to the cloud, once:
  - records in backend/data/app.db (users, plans, billing, listings, settings) -> Supabase (DATABASE_URL)
  - photos and videos in backend/storage                                     -> Bunny (BUNNY_*)

Stop the local backend first. Safe to run again: rows are updated in place and files overwritten.
Nothing local is deleted; remove backend/data and backend/storage yourself once the app works.

Run from the backend folder:  .venv\\Scripts\\python move_to_cloud.py
"""
from __future__ import annotations

import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pla.envfile import load_env_files  # noqa: E402

load_env_files()

from pla import bunny, config, db  # noqa: E402

# Parents before children, so the foreign keys are satisfied. The second value is the primary key.
TABLES = [
    ("users", "id"), ("plans", "id"), ("products", "id"), ("jobs", "id"), ("sources", "id"),
    ("images", "id"), ("videos", "id"), ("billing_requests", "id"), ("search_log", "id"),
    ("settings", "key"), ("counters", "name"), ("creative_cache", "cache_key"),
]


def copy_records(local: sqlite3.Connection) -> None:
    present = {row[0] for row in local.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    for table, key in TABLES:
        if table not in present:
            continue
        cloud_columns = {r["column_name"] for r in db.all_rows("SELECT column_name FROM information_schema.columns WHERE table_name = ?", (table,))}
        rows = local.execute(f"SELECT * FROM {table} ORDER BY rowid").fetchall()
        if not rows:
            print(f"  {table}: empty")
            continue
        columns = [c for c in rows[0].keys() if c in cloud_columns]
        updates = ", ".join(f"{c} = EXCLUDED.{c}" for c in columns if c != key)
        sql = (
            f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({', '.join('?' * len(columns))}) "
            f"ON CONFLICT ({key}) DO {'UPDATE SET ' + updates if updates else 'NOTHING'}"
        )
        with db.transaction() as connection:
            for row in rows:
                connection.execute(sql, [row[c] for c in columns])
        print(f"  {table}: {len(rows)} rows")


def copy_files() -> None:
    root = config.storage_dir()
    if not os.path.isdir(root):
        print("  no storage folder, nothing to copy")
        return
    count = 0
    for product_id in sorted(os.listdir(root)):
        if product_id == "creatives":  # short-lived thumbnails, not product files
            continue
        for kind in ("images", "videos"):
            folder = os.path.join(root, product_id, kind)
            if not os.path.isdir(folder):
                continue
            for name in sorted(os.listdir(folder)):
                if name.startswith("tmp-") or name.endswith(".part"):
                    continue
                bunny.upload(os.path.join(folder, name), bunny.remote_path(product_id, kind, name))
                count += 1
                if count % 20 == 0:
                    print(f"  {count} files sent...")
    print(f"  {count} files on Bunny")


def main() -> None:
    if not db.is_postgres():
        sys.exit("DATABASE_URL is empty in backend/.env. Add the Supabase connection first.")
    if not bunny.enabled():
        sys.exit("The BUNNY_* settings are not all filled in backend/.env.")
    path = os.path.join(config.data_dir(), "app.db")
    if not os.path.isfile(path):
        sys.exit(f"No local database at {path}.")
    local = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    local.row_factory = sqlite3.Row
    print("Records -> Supabase")
    try:
        copy_records(local)
    except Exception as error:  # noqa: BLE001
        if "deadlock" in str(error) or "lock timeout" in str(error):
            sys.exit("\nAnother backend is writing to Supabase at the same time. Stop every running backend "
                     "(Ctrl+C in its window), then run this again. It is safe to run again.")
        raise
    local.close()
    print("Files -> Bunny")
    copy_files()
    print("Done. The app now reads everything from Supabase and Bunny.")


if __name__ == "__main__":
    main()

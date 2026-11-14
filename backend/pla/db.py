"""The database.

- DATABASE_URL set (Supabase Postgres): that is the only database. Every backend (your computer,
  Fly.io) reads and writes the same records, and nothing is kept on the server's own disk.
- DATABASE_URL empty: a local SQLite file (data/app.db), for development and the tests.

The app's SQL is written once, with ? placeholders and SQL that both databases understand. On
Postgres the placeholders become %s. Postgres tables come from backend/schema.sql; SQLite tables
from SCHEMA below.
"""
from __future__ import annotations

import hashlib
import os
import sqlite3
import threading
import time
from contextlib import contextmanager
from decimal import Decimal
from urllib.parse import urlparse

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  stage TEXT NOT NULL,
  input_name TEXT,
  input_image TEXT,
  input_images TEXT NOT NULL DEFAULT '[]',
  input_video TEXT,
  input_urls TEXT NOT NULL DEFAULT '[]',
  search_photos INTEGER NOT NULL DEFAULT 1,
  search_videos INTEGER NOT NULL DEFAULT 1,
  blocked_urls TEXT NOT NULL DEFAULT '[]',
  vision TEXT,
  name TEXT,
  name_options TEXT NOT NULL DEFAULT '[]',
  description TEXT,
  source_text TEXT,
  claims TEXT NOT NULL DEFAULT '[]',
  seller_name TEXT,
  low_images INTEGER NOT NULL DEFAULT 0,
  warnings TEXT NOT NULL DEFAULT '[]',
  sku TEXT UNIQUE,
  price TEXT,
  cost TEXT,
  shopify_status TEXT NOT NULL DEFAULT 'ready',
  shopify_product_id TEXT,
  shopify_admin_url TEXT,
  shopify_handle TEXT,
  shopify_error TEXT,
  shopify_warnings TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  step TEXT,
  message TEXT,
  log TEXT NOT NULL DEFAULT '[]',
  skip_search INTEGER NOT NULL DEFAULT 0,
  usage TEXT NOT NULL DEFAULT '{}',
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, seq);
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT,
  seller TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  text TEXT,
  seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  file_name TEXT,
  source_url TEXT,
  source_page TEXT,
  width INTEGER,
  height INTEGER,
  bytes INTEGER,
  phash TEXT,
  passed INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  checks TEXT NOT NULL DEFAULT '{}',
  selected INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  uploaded INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  provider TEXT,
  url TEXT,
  file_name TEXT,
  source_page TEXT,
  bytes INTEGER,
  passed INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  selected INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  uploaded INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS creative_cache (
  cache_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- The Shopify stores a signed-in user connected. How many a user may have comes from the plan.
CREATE TABLE IF NOT EXISTS shopify_stores (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'client',
  client_id TEXT NOT NULL DEFAULT '',
  client_secret TEXT NOT NULL DEFAULT '',
  admin_token TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS shopify_stores_owner_domain ON shopify_stores (owner_id, domain);
"""

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PG_SCHEMA_FILE = os.path.join(BACKEND_DIR, "schema.sql")
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}

_local = threading.local()
_tx_depth = threading.local()
_init_lock = threading.Lock()
_initialized: str | None = None


def is_postgres() -> bool:
    return bool(config.database_url())


def insert_order() -> str:
    """A column that keeps rows in the order they were added, to break ties after position."""
    return "added" if is_postgres() else "rowid"


# ---------- SQLite (no DATABASE_URL) ----------

def _db_path() -> str:
    folder = config.data_dir()
    os.makedirs(folder, exist_ok=True)
    return os.path.join(folder, "app.db")


def _migrate(conn: sqlite3.Connection) -> None:
    def add_column(table: str, name: str, definition: str) -> None:
        columns = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
        if name not in columns:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {definition}")

    add_column("products", "input_details", "input_details TEXT")
    add_column("products", "input_images", "input_images TEXT NOT NULL DEFAULT '[]'")
    add_column("products", "search_photos", "search_photos INTEGER NOT NULL DEFAULT 1")
    add_column("products", "search_videos", "search_videos INTEGER NOT NULL DEFAULT 1")
    add_column("jobs", "usage", "usage TEXT NOT NULL DEFAULT '{}'")
    add_column("products", "category", "category TEXT")
    # Which signed-in account made the listing. Empty for listings made before accounts existed.
    add_column("products", "owner_id", "owner_id TEXT")


def _open_sqlite(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path, timeout=5, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


# ---------- Postgres (DATABASE_URL) ----------

def _number(value):
    # SUM and similar can come back as Decimal; the app and JSON expect plain numbers.
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    return value


class _PgCursor:
    """Rows as dicts, so row["name"] and dict(row) work as they do with sqlite3.Row."""

    def __init__(self, cursor):
        self._cursor = cursor
        self.rowcount = cursor.rowcount

    def fetchone(self) -> dict | None:
        if self._cursor.description is None:
            return None
        row = self._cursor.fetchone()
        return {k: _number(v) for k, v in row.items()} if row is not None else None

    def fetchall(self) -> list[dict]:
        if self._cursor.description is None:
            return []
        return [{k: _number(v) for k, v in row.items()} for row in self._cursor.fetchall()]

    def __iter__(self):
        return iter(self.fetchall())


class _PgConnection:
    """Takes the app's SQLite-style SQL: ? placeholders, and True/False stored as 1/0."""

    def __init__(self, raw):
        self.raw = raw

    def execute(self, sql: str, params: tuple | list = ()) -> _PgCursor:
        if not params:
            return _PgCursor(self.raw.execute(sql))
        values = [int(p) if isinstance(p, bool) else p for p in params]
        return _PgCursor(self.raw.execute(sql.replace("%", "%%").replace("?", "%s"), values))

    def alive(self) -> bool:
        return not self.raw.closed and not self.raw.broken

    def close(self) -> None:
        self.raw.close()


def _pg_connect() -> _PgConnection:
    import psycopg
    from psycopg.rows import dict_row

    url = config.database_url()
    extra = {}
    if "sslmode=" not in url and (urlparse(url).hostname or "").lower() not in LOCAL_HOSTS:
        extra["sslmode"] = "require"
    # prepare_threshold=None: Supabase's connection pooler does not keep prepared statements.
    raw = psycopg.connect(url, autocommit=True, row_factory=dict_row, prepare_threshold=None, connect_timeout=10, **extra)
    return _PgConnection(raw)


def _pg_setup(connection: _PgConnection) -> None:
    """Creates any missing table or column, only when schema.sql changed since the last setup.

    Changing a table locks it, so this is not repeated on every start: with another backend (or a
    job) using the tables, that could deadlock. A busy table makes it give up and try again."""
    import psycopg

    with open(PG_SCHEMA_FILE, encoding="utf-8") as handle:
        script = handle.read()
    version = hashlib.sha256(script.encode()).hexdigest()[:16]
    try:
        row = connection.raw.execute("SELECT value FROM settings WHERE key = 'schema_version'").fetchone()
        if row and row["value"] == version:
            return
    except psycopg.errors.UndefinedTable:
        pass  # a new database: set it up below
    for attempt in range(1, 6):
        try:
            connection.raw.execute(script)
            connection.raw.execute(
                "INSERT INTO settings (key, value) VALUES ('schema_version', %s) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
                (version,),
            )
            return
        except (psycopg.errors.DeadlockDetected, psycopg.errors.LockNotAvailable):
            try:
                connection.raw.execute("ROLLBACK")
            except psycopg.Error:
                pass
            if attempt == 5:
                raise
            time.sleep(2 * attempt)


# ---------- Shared ----------

def conn():
    """This thread's connection, opened (and the tables set up) on first use."""
    global _initialized
    key = config.database_url() or _db_path()
    current = getattr(_local, "conn", None)
    if current is not None and getattr(_local, "key", None) == key and (not isinstance(current, _PgConnection) or current.alive()):
        return current
    with _init_lock:
        if is_postgres():
            connection = _pg_connect()
            if _initialized != key:
                _pg_setup(connection)
                _initialized = key
        else:
            connection = _open_sqlite(key)
            if _initialized != key:
                connection.executescript(SCHEMA)
                _migrate(connection)
                _initialized = key
    _local.conn = connection
    _local.key = key
    return connection


def ensure_sqlite_tables(script: str) -> None:
    """Runs CREATE TABLE statements on SQLite. On Postgres every table is in schema.sql already."""
    if not is_postgres():
        conn().executescript(script)


def _run(sql: str, params: tuple | list):
    connection = conn()
    try:
        return connection.execute(sql, params)
    except Exception as error:
        # A dropped Postgres connection is opened again once, unless a transaction was under way.
        if not isinstance(connection, _PgConnection) or getattr(_tx_depth, "n", 0) or connection.alive():
            raise
        import psycopg

        if not isinstance(error, psycopg.OperationalError):
            raise
        _local.conn = None
        return conn().execute(sql, params)


def execute(sql: str, params: tuple | list = ()):
    return _run(sql, params)


def one(sql: str, params: tuple | list = ()) -> dict | None:
    row = _run(sql, params).fetchone()
    return dict(row) if row is not None else None


def all_rows(sql: str, params: tuple | list = ()) -> list[dict]:
    return [dict(row) for row in _run(sql, params).fetchall()]


@contextmanager
def transaction():
    """BEGIN ... COMMIT. Nested calls join the outer transaction."""
    connection = conn()
    depth = getattr(_tx_depth, "n", 0)
    if depth == 0:
        connection.execute("BEGIN" if isinstance(connection, _PgConnection) else "BEGIN IMMEDIATE")
    _tx_depth.n = depth + 1
    try:
        yield connection
    except BaseException:
        _tx_depth.n = depth
        if depth == 0:
            connection.execute("ROLLBACK")
        raise
    _tx_depth.n = depth
    if depth == 0:
        connection.execute("COMMIT")


def close_thread_connection() -> None:
    current = getattr(_local, "conn", None)
    if current is not None:
        try:
            current.close()
        except Exception:  # noqa: BLE001
            pass
        _local.conn = None

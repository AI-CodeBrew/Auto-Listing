import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config";
import { scheduleSupabaseSync, startSupabaseSync } from "./supabase";

const SCHEMA = `
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
`;

// Next can load this module more than once (per route bundle), so the
// connection lives on globalThis.
const holder = globalThis as unknown as { __plaDb?: Database.Database };

/** The connection survives a reload, so this flag lives with the module and runs the new columns again. */
let migrated = false;

function migrate(conn: Database.Database): void {
  const addColumn = (table: string, name: string, definition: string) => {
    const columns = conn.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some((column) => column.name === name)) conn.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  };
  // Columns added after the first release. CREATE TABLE does not alter a database that already exists.
  addColumn("products", "input_details", "input_details TEXT");
  addColumn("products", "input_images", "input_images TEXT NOT NULL DEFAULT '[]'");
  addColumn("products", "search_photos", "search_photos INTEGER NOT NULL DEFAULT 1");
  addColumn("products", "search_videos", "search_videos INTEGER NOT NULL DEFAULT 1");
  addColumn("jobs", "usage", "usage TEXT NOT NULL DEFAULT '{}'");
  addColumn("products", "category", "category TEXT");
  conn.exec(`CREATE TABLE IF NOT EXISTS creative_cache (
    cache_key TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  migrated = true;
}

export function db(): Database.Database {
  if (!holder.__plaDb) {
    const dir = config.dataDir();
    fs.mkdirSync(dir, { recursive: true });
    const conn = new Database(path.join(dir, "app.db"));
    conn.pragma("journal_mode = WAL");
    conn.pragma("foreign_keys = ON");
    conn.pragma("busy_timeout = 5000");
    conn.exec(SCHEMA);
    // A fresh deployment database is empty. Hold copies until the saved records are loaded.
    if (process.env.VERCEL) syncPaused = true;
    watchWrites(conn);
    holder.__plaDb = conn;
    startSupabaseSync((table) => readTable(conn, table));
  }
  if (!migrated) migrate(holder.__plaDb);
  return holder.__plaDb;
}

const SYNC_TABLES = new Set(["products", "jobs", "sources", "images", "videos", "settings", "counters"]);

/** While a deployment is loading the saved copy, those inserts must not copy the empty database back. */
let syncPaused = false;

export function setSyncPaused(paused: boolean): void {
  syncPaused = paused;
}

function readTable(conn: Database.Database, table: string): Record<string, unknown>[] {
  if (!SYNC_TABLES.has(table)) return [];
  const exists = conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!exists) return [];
  return conn.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
}

/** A local write is copied to Supabase. Reads stay on this computer, so a slow copy never blocks the page. */
function watchWrites(conn: Database.Database): void {
  const prepare = conn.prepare.bind(conn);
  conn.prepare = ((sql: string) => {
    const stmt = prepare(sql);
    const run = stmt.run.bind(stmt);
    stmt.run = ((...args: Parameters<typeof stmt.run>) => {
      const result = run(...args);
      if (!syncPaused) scheduleSupabaseSync();
      return result;
    }) as typeof stmt.run;
    return stmt;
  }) as typeof conn.prepare;
  const exec = conn.exec.bind(conn);
  conn.exec = ((sql: string) => {
    exec(sql);
    if (!syncPaused && !sql.includes("PRAGMA")) scheduleSupabaseSync();
  }) as typeof conn.exec;
}

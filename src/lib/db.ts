import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  stage TEXT NOT NULL,
  input_name TEXT,
  input_image TEXT,
  input_video TEXT,
  input_urls TEXT NOT NULL DEFAULT '[]',
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
`;

// Next can load this module more than once (per route bundle), so the
// connection lives on globalThis.
const holder = globalThis as unknown as { __plaDb?: Database.Database };

export function db(): Database.Database {
  if (!holder.__plaDb) {
    const dir = config.dataDir();
    fs.mkdirSync(dir, { recursive: true });
    const conn = new Database(path.join(dir, "app.db"));
    conn.pragma("journal_mode = WAL");
    conn.pragma("foreign_keys = ON");
    conn.pragma("busy_timeout = 5000");
    conn.exec(SCHEMA);
    // Columns added after the first release.
    const columns = conn.prepare("PRAGMA table_info(products)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "input_details")) conn.exec("ALTER TABLE products ADD COLUMN input_details TEXT");
    holder.__plaDb = conn;
  }
  return holder.__plaDb;
}

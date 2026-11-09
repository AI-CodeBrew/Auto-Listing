import type Database from "better-sqlite3";
import postgres, { type Sql } from "postgres";
import { config } from "./config";

const TABLES = ["products", "jobs", "sources", "images", "videos", "settings", "counters"] as const;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id text PRIMARY KEY,
  stage text NOT NULL,
  input_name text,
  input_details text,
  input_image text,
  input_images text NOT NULL DEFAULT '[]',
  input_video text,
  input_urls text NOT NULL DEFAULT '[]',
  search_photos integer NOT NULL DEFAULT 1,
  search_videos integer NOT NULL DEFAULT 1,
  blocked_urls text NOT NULL DEFAULT '[]',
  vision text,
  name text,
  name_options text NOT NULL DEFAULT '[]',
  category text,
  description text,
  source_text text,
  claims text NOT NULL DEFAULT '[]',
  seller_name text,
  low_images integer NOT NULL DEFAULT 0,
  warnings text NOT NULL DEFAULT '[]',
  sku text UNIQUE,
  price text,
  cost text,
  shopify_status text NOT NULL DEFAULT 'ready',
  shopify_product_id text,
  shopify_admin_url text,
  shopify_handle text,
  shopify_error text,
  shopify_warnings text NOT NULL DEFAULT '[]',
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id text PRIMARY KEY,
  seq integer NOT NULL,
  product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  status text NOT NULL,
  step text,
  message text,
  log text NOT NULL DEFAULT '[]',
  skip_search integer NOT NULL DEFAULT 0,
  usage text NOT NULL DEFAULT '{}',
  attempts integer NOT NULL DEFAULT 0,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  finished_at text
);
CREATE TABLE IF NOT EXISTS sources (
  id text PRIMARY KEY,
  product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url text NOT NULL,
  title text,
  seller text,
  status text NOT NULL,
  reason text,
  text text,
  seq integer NOT NULL
);
CREATE TABLE IF NOT EXISTS images (
  id text PRIMARY KEY,
  product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  file_name text,
  source_url text,
  source_page text,
  width integer,
  height integer,
  bytes integer,
  phash text,
  passed integer NOT NULL DEFAULT 0,
  reason text,
  checks text NOT NULL DEFAULT '{}',
  selected integer NOT NULL DEFAULT 0,
  position integer NOT NULL DEFAULT 0,
  uploaded integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS videos (
  id text PRIMARY KEY,
  product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  kind text NOT NULL,
  provider text,
  url text,
  file_name text,
  source_page text,
  bytes integer,
  passed integer NOT NULL DEFAULT 0,
  reason text,
  selected integer NOT NULL DEFAULT 0,
  position integer NOT NULL DEFAULT 0,
  uploaded integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY,
  value text NOT NULL
);
CREATE TABLE IF NOT EXISTS counters (
  name text PRIMARY KEY,
  value integer NOT NULL
);
`;

type Row = Record<string, unknown>;

const holder = globalThis as unknown as { __plaSupabase?: Sql };

let readRows: ((table: string) => Row[]) | null = null;
let schemaReady: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let copying = false;
let queued = false;

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const url = config.databaseUrl();
  let password = "";
  try {
    password = decodeURIComponent(new URL(url).password);
  } catch {
    password = "";
  }
  return message.replaceAll(url, "database").replaceAll(password, "password");
}

function client(): Sql | null {
  const url = config.databaseUrl();
  if (!url) return null;
  if (!holder.__plaSupabase) {
    holder.__plaSupabase = postgres(url, {
      prepare: false,
      ssl: "require",
      max: 1,
      connect_timeout: 8,
      idle_timeout: 20,
      queue_timeout: 8,
      query_timeout: 8,
      onnotice: () => undefined,
    });
  }
  return holder.__plaSupabase;
}

async function ensureSchema(sql: Sql): Promise<void> {
  await sql.unsafe(SCHEMA);
  // These rules already exist. A lock here must not stop the site from opening.
  try {
    await sql.unsafe(`
      REVOKE ALL ON TABLE products, jobs, sources, images, videos, settings, counters FROM anon, authenticated;
      ALTER TABLE products ENABLE ROW LEVEL SECURITY;
      ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
      ALTER TABLE sources ENABLE ROW LEVEL SECURITY;
      ALTER TABLE images ENABLE ROW LEVEL SECURITY;
      ALTER TABLE videos ENABLE ROW LEVEL SECURITY;
      ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
      ALTER TABLE counters ENABLE ROW LEVEL SECURITY;
    `);
  } catch (error) {
    console.error("[supabase] Access rules were not changed:", safeMessage(error));
  }
}

async function copyTable(sql: Sql, table: (typeof TABLES)[number], rows: Row[]): Promise<void> {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]);
  await sql`INSERT INTO ${sql(table)} ${sql(rows, ...keys)}`;
}

async function copyAll(): Promise<void> {
  const sql = client();
  if (!sql || !readRows) return;
  const snapshot = TABLES.map((table) => ({ table, rows: readRows!(table) }));
  await sql.begin(async (tx) => {
    for (const table of ["videos", "images", "sources", "jobs", "products", "settings", "counters"]) {
      await tx.unsafe(`DELETE FROM ${table}`);
    }
    for (const item of snapshot) await copyTable(tx as unknown as Sql, item.table, item.rows);
  });
}

const gate = globalThis as unknown as { __plaReady?: Promise<void> };

/** On the deployed site, load the saved copy before any page reads or writes. */
export function whenReady(): Promise<void> {
  if (!gate.__plaReady) gate.__plaReady = prepareDeployment();
  return gate.__plaReady;
}

function localCount(conn: Database.Database, table: string): number {
  const exists = conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!exists) return 0;
  const row = conn.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return Number(row.n);
}

async function prepareDeployment(): Promise<void> {
  if (!process.env.VERCEL) return;
  if (!config.databaseUrl()) {
    console.error("[supabase] DATABASE_URL is missing on the server");
    return;
  }
  const { db, setSyncPaused } = await import("./db");
  const conn = db();
  setSyncPaused(true);
  try {
    if (schemaReady) await schemaReady;
    const sql = client();
    if (!sql) return;
    // A restarted server can already have an empty settings row. Load the saved products anyway.
    if (localCount(conn, "products") === 0) {
      conn.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      for (const table of TABLES) {
        const rows = (await sql.unsafe(`SELECT * FROM ${table}`)) as Row[];
        insertRows(conn, table, rows);
      }
      console.log("[supabase] saved products", localCount(conn, "products"));
    }
    setSyncPaused(false);
  } catch (error) {
    console.error("[supabase] Could not load saved records:", safeMessage(error));
  }
}

function newerThan(conn: Database.Database, table: string, id: string, remoteUpdated: unknown): boolean {
  const local = conn.prepare(`SELECT updated_at FROM ${table} WHERE id = ?`).get(id) as { updated_at: string } | undefined;
  if (!local) return true;
  return String(remoteUpdated ?? "") > local.updated_at;
}

const JOB_UPDATE = new Set(["step", "log", "status", "message", "updated_at", "finished_at"]);

const CONFLICT: Record<string, string> = { settings: "key", counters: "name" };

/** Inserts or replaces one row. A full copy of every table is too slow while a search is open. */
async function upsertRow(sql: Sql, table: string, row: Row): Promise<void> {
  const keys = Object.keys(row).filter((key) => row[key] !== undefined);
  if (!keys.length) return;
  const conflict = CONFLICT[table] ?? "id";
  const updates = keys.filter((key) => key !== conflict);
  if (!updates.length) {
    await sql`INSERT INTO ${sql(table)} ${sql(row, ...keys)} ON CONFLICT (${sql(conflict)}) DO NOTHING`;
    return;
  }
  await sql`INSERT INTO ${sql(table)} ${sql(row, ...keys)} ON CONFLICT (${sql(conflict)}) DO UPDATE SET ${sql(row, ...updates)}`;
}

/**
 * Saves one product and the rows that belong to it.
 * Copying every product, photo, and video at once was timing out, so a new search never became visible.
 */
export async function pushRecords(productId: string): Promise<void> {
  if (!process.env["VERCEL"] || !config.databaseUrl() || !readRows) return;
  const sql = client();
  if (!sql) return;
  const products = readRows("products").filter((row) => row.id === productId);
  if (!products.length) return;
  const owned = (table: string) => readRows!(table).filter((row) => row.product_id === productId);
  try {
    for (const row of products) await upsertRow(sql, "products", row);
    for (const table of ["jobs", "sources", "images", "videos"] as const) {
      for (const row of owned(table)) await upsertRow(sql, table, row);
    }
  } catch (error) {
    console.error("[supabase] Could not save this search:", safeMessage(error));
    throw error;
  }
}

/** Saves one search step without copying every record. */
export async function pushJobUpdate(id: string, fields: Record<string, string | null>): Promise<void> {
  if (!process.env["VERCEL"] || !config.databaseUrl()) return;
  const sql = client();
  if (!sql) return;
  const keys = Object.keys(fields).filter((key) => JOB_UPDATE.has(key));
  if (!keys.length) return;
  try {
    await sql`UPDATE jobs SET ${sql(fields, ...keys)} WHERE id = ${id}`;
  } catch (error) {
    console.error("[supabase] Could not update the search step:", safeMessage(error));
  }
}

/** Reads one product and its latest search. Used while a search is on screen. */
export async function pullOne(id: string): Promise<void> {
  if (!process.env["VERCEL"] || !config.databaseUrl()) return;
  const sql = client();
  if (!sql) return;
  try {
    const products = (await sql`SELECT * FROM products WHERE id = ${id}`) as Row[];
    const jobs = (await sql`SELECT * FROM jobs WHERE product_id = ${id} ORDER BY seq DESC LIMIT 1`) as Row[];
    if (!products.length && !jobs.length) return;
    const { db, isSyncPaused, setSyncPaused } = await import("./db");
    const conn = db();
    const paused = isSyncPaused();
    setSyncPaused(true);
    try {
      if (products[0] && newerThan(conn, "products", String(products[0].id), products[0].updated_at)) insertRows(conn, "products", [products[0]]);
      if (jobs[0] && newerThan(conn, "jobs", String(jobs[0].id), jobs[0].updated_at)) insertRows(conn, "jobs", [jobs[0]]);
    } finally {
      setSyncPaused(paused);
    }
  } catch (error) {
    console.error("[supabase] Could not refresh this search:", safeMessage(error));
  }
}

/** The deployed site has more than one server. A search runs on one of them, so the page reads the saved copy. */
export async function pullLatest(): Promise<void> {
  if (!process.env["VERCEL"] || !config.databaseUrl()) return;
  const sql = client();
  if (!sql) return;
  try {
    const products = (await sql`SELECT * FROM products ORDER BY updated_at DESC LIMIT 40`) as Row[];
    const jobs = (await sql`SELECT * FROM jobs ORDER BY updated_at DESC LIMIT 40`) as Row[];
    const images = (await sql`SELECT * FROM images LIMIT 200`) as Row[];
    const sources = (await sql`SELECT * FROM sources LIMIT 200`) as Row[];
    const videos = (await sql`SELECT * FROM videos LIMIT 100`) as Row[];
    const { db, isSyncPaused, setSyncPaused } = await import("./db");
    const conn = db();
    const paused = isSyncPaused();
    setSyncPaused(true);
    try {
      for (const row of products) {
        if (newerThan(conn, "products", String(row.id), row.updated_at)) insertRows(conn, "products", [row]);
      }
      for (const row of jobs) {
        if (newerThan(conn, "jobs", String(row.id), row.updated_at)) insertRows(conn, "jobs", [row]);
      }
      for (const [table, rows] of [
        ["images", images],
        ["sources", sources],
        ["videos", videos],
      ] as const) {
        for (const row of rows) {
          if (!conn.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(String(row.id))) insertRows(conn, table, [row]);
        }
      }
    } finally {
      setSyncPaused(paused);
    }
  } catch (error) {
    console.error("[supabase] Could not refresh records:", safeMessage(error));
  }
}

function insertRows(conn: Database.Database, table: string, rows: Row[]): void {
  if (!rows.length) return;
  const known = new Set((conn.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name));
  const columns = Object.keys(rows[0]).filter((column) => known.has(column));
  if (!columns.length) return;
  const statement = conn.prepare(`INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
  const write = conn.transaction((items: Row[]) => {
    for (const row of items) {
      statement.run(...columns.map((column) => (row[column] === undefined ? null : row[column])));
    }
  });
  write(rows);
}

async function flush(): Promise<void> {
  if (schemaReady) await schemaReady.catch(() => undefined);
  await whenReady();
  if (copying) {
    queued = true;
    return;
  }
  copying = true;
  try {
    do {
      queued = false;
      await copyAll();
    } while (queued);
  } catch (error) {
    console.error("[supabase] Could not copy records:", safeMessage(error));
  } finally {
    copying = false;
  }
}

/** Opens the Supabase database, creates the tables, and copies the local records. */
export function startSupabaseSync(read: (table: string) => Row[]): void {
  readRows = read;
  if (!config.databaseUrl() || schemaReady) return;
  const sql = client();
  if (!sql) return;
  // The deployed site only reads the saved records. Creating tables on every open locks the database.
  if (process.env.VERCEL) {
    schemaReady = Promise.resolve();
    return;
  }
  schemaReady = ensureSchema(sql).catch((error: unknown) => {
    console.error("[supabase] Setup failed:", safeMessage(error));
  });
  void schemaReady.then(() => {
    void flush();
  });
}

/** Saves the local records immediately. Used before the deployed site answers, so the next page can see them. */
export function saveNow(): Promise<void> {
  return flush();
}

/** Copies the local database again shortly after a change. */
export function scheduleSupabaseSync(): void {
  if (!config.databaseUrl() || !readRows) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, 400);
}

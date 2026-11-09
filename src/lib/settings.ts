import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config";
import { db } from "./db";

/**
 * Settings the user enters on the Shopify page. They are kept in the local database.
 * A value saved on the page wins. Anything not saved there falls back to the same
 * name in .env, so an existing .env keeps working.
 */
export type ShopifySettingKey = "shopify_domain" | "shopify_client_id" | "shopify_client_secret";

const ENV_NAME: Record<ShopifySettingKey, string> = {
  shopify_domain: "SHOPIFY_STORE_DOMAIN",
  shopify_client_id: "SHOPIFY_CLIENT_ID",
  shopify_client_secret: "SHOPIFY_CLIENT_SECRET",
};

function ensureTable() {
  db().exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
}

function readSaved(key: ShopifySettingKey): string {
  ensureTable();
  const row = db().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? "";
}

/** Accepts "my-store", "my-store.myshopify.com" or a full URL, and returns "my-store.myshopify.com". */
export function normalizeDomain(input: string): string {
  const host = input
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/[/?#].*$/, "")
    .toLowerCase();
  if (!host) return "";
  return host.includes(".") ? host : `${host}.myshopify.com`;
}

export function isValidDomain(domain: string): boolean {
  return /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(domain);
}

export interface ShopifyCredentials {
  domain: string;
  clientId: string;
  clientSecret: string;
}

export function shopifyCredentials(): ShopifyCredentials {
  const value = (key: ShopifySettingKey) => readSaved(key) || (process.env[ENV_NAME[key]] ?? "").trim();
  return {
    domain: normalizeDomain(value("shopify_domain")),
    clientId: value("shopify_client_id").trim(),
    clientSecret: value("shopify_client_secret").trim(),
  };
}

export function saveShopifyCredentials(input: { domain: string; clientId: string; clientSecret?: string }): void {
  ensureTable();
  const upsert = db().prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  db().transaction(() => {
    upsert.run("shopify_domain", normalizeDomain(input.domain));
    upsert.run("shopify_client_id", input.clientId.trim());
    // An empty secret means "keep the one already saved".
    if (input.clientSecret?.trim()) upsert.run("shopify_client_secret", input.clientSecret.trim());
  })();
}

export function clearShopifyCredentials(): void {
  ensureTable();
  db().prepare("DELETE FROM settings WHERE key IN ('shopify_domain', 'shopify_client_id', 'shopify_client_secret')").run();
}

/** What the Shopify page may show. The secret itself is never sent to the browser. */
export function shopifySummary() {
  const creds = shopifyCredentials();
  const savedHere = Boolean(readSaved("shopify_client_secret") || readSaved("shopify_domain") || readSaved("shopify_client_id"));
  return {
    domain: creds.domain,
    clientId: creds.clientId,
    hasSecret: Boolean(creds.clientSecret),
    source: savedHere ? ("page" as const) : creds.domain || creds.clientId || creds.clientSecret ? ("env" as const) : ("none" as const),
  };
}

// ---------- Which SerpAPI key is in use ----------

export interface SerpPreference {
  active: 1 | 2;
  /** When the active key has no searches left, use the other key. */
  auto: boolean;
}

function readSetting(key: string): string {
  ensureTable();
  const row = db().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? "";
}

function writeSetting(key: string, value: string): void {
  ensureTable();
  db().prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

/** Key choice saved in the app. The keys themselves stay in .env and are never stored here. */
export function serpPreference(): SerpPreference {
  return {
    active: readSetting("serp_active") === "2" ? 2 : 1,
    auto: readSetting("serp_auto") !== "0",
  };
}

export function saveSerpPreference(input: Partial<SerpPreference>): SerpPreference {
  const current = serpPreference();
  const active = input.active === 1 || input.active === 2 ? input.active : current.active;
  const auto = typeof input.auto === "boolean" ? input.auto : current.auto;
  writeSetting("serp_active", String(active));
  writeSetting("serp_auto", auto ? "1" : "0");
  return { active, auto };
}

// ---------- Public link to the uploaded photo (for Google Lens) ----------

/** A random secret made once and kept in the database. It signs the public photo links. */
function linkSecret(): string {
  ensureTable();
  const row = db().prepare("SELECT value FROM settings WHERE key = 'link_secret'").get() as { value: string } | undefined;
  if (row) return row.value;
  const secret = randomBytes(32).toString("hex");
  db().prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('link_secret', ?)").run(secret);
  return (db().prepare("SELECT value FROM settings WHERE key = 'link_secret'").get() as { value: string }).value;
}

export function photoToken(productId: string): string {
  return createHmac("sha256", linkSecret()).update(`photo:${productId}`).digest("hex");
}

export function photoTokenValid(productId: string, token: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(token)) return false;
  return timingSafeEqual(Buffer.from(photoToken(productId)), Buffer.from(token));
}

// ---------- FastMoss ----------

/** The FastMoss key lives only in .env. It is never entered or shown in the app. */
export function fastmossApiKey(): string {
  return (process.env.FASTMOSS_API_KEY ?? "").trim();
}

/** The public address Google Lens uses to fetch the product's uploaded photo. Empty if no tunnel is set up. */
export function publicPhotoUrl(productId: string): string {
  const base = config.publicBaseUrl();
  return base ? `${base}/api/public-photo/${productId}/${photoToken(productId)}.jpg` : "";
}

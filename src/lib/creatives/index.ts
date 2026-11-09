import fs from "node:fs";
import { identifyProductImage, type ProductIdentity } from "../ai";
import { LIMITS } from "../config";
import { db } from "../db";
import { forVision } from "../media/images";
import { commitFile, removeQuietly, tempPath } from "../storage";
import { downloadToFile, FetchError, TooLargeError } from "../web/net";
import { collectMetaAds } from "./metaAds";
import { applyNormalizedScores } from "./scoring";
import { CreativeError, type CreativeRequest, type FindResult, type RankedCreative } from "./types";
import { collectYoutube } from "./youtube";

const CACHE_MS = 24 * 60 * 60 * 1000;
const TOP_SOURCE = 15;
const TOP_COMBINED = 20;

export { CreativeError } from "./types";
export type { CreativeRequest, FindResult, RankedCreative } from "./types";

/** Reads the brand, model, color, and packaging text, then builds exact searches. */
export async function analyzeImage(jpeg: Buffer): Promise<ProductIdentity> {
  const draft = await identifyProductImage({ data: jpeg });
  const brand = clip(draft.brand);
  const model = clip(draft.model);
  const color = clip(draft.color);
  const packagingText = clip(draft.packagingText);
  const seen = clip(draft.title);
  const specific = [brand, model, color].filter(Boolean);
  const title = (seen && (!brand || seen.toLowerCase().includes(brand.toLowerCase())) ? seen : specific.join(" ")).slice(0, 200);
  const arabic = draft.keywords.map(clip).find((word) => /[\u0600-\u06FF]/.test(word));
  const colorAlreadyInName = Boolean(color && title.toLowerCase().includes(color.toLowerCase()));
  const keywords = cleanKeywords([
    title && `${title} review`,
    title && `${title} tiktok made me buy it`,
    title && color && !colorAlreadyInName ? `${color} ${title}` : packagingText ? `${title} ${packagingText}` : "",
    arabic || "",
    ...draft.keywords,
  ]).slice(0, 4);
  if (!title || keywords.length === 0) {
    throw new CreativeError("The image could not be identified as a product. Try a clearer photo.");
  }
  return { brand, model, color, packagingText, title, keywords };
}

/**
 * Identifies the product, searches YouTube and the Meta Ad Library together,
 * and returns ranked lists. A repeat within 24 hours is served from the local database.
 */
export async function findCreatives(input: CreativeRequest): Promise<FindResult> {
  const days = clampDays(input.days);
  const shortsOnly = input.shortsOnly;
  let title = clip(input.title ?? "").slice(0, 200);
  let keywords = cleanKeywords(input.keywords ?? []);
  let brand = clip(input.brand ?? "");
  let model = clip(input.model ?? "");
  let color = clip(input.color ?? "");
  let packagingText = clip(input.packagingText ?? "");

  const jpeg = await loadImage(input);
  storeImage(jpeg);
  if (!keywords.length) {
    const found = await analyzeImage(jpeg);
    title = found.title;
    keywords = found.keywords;
    brand = found.brand;
    model = found.model;
    color = found.color;
    packagingText = found.packagingText;
  }
  if (!title || !keywords.length) {
    throw new CreativeError("Upload a product image or paste an image URL.");
  }

  const key = cacheKey(title, keywords, shortsOnly, days);
  const cached = readCache(key);
  if (cached) {
    console.info(`[creatives] quota used 0 for "${cached.product}" (cached)`);
    return cached;
  }

  const publishedAfter = new Date(Date.now() - days * 86_400_000).toISOString();
  const [youtubeResult, metaResult] = await Promise.all([
    collectYoutube(keywords, { shortsOnly, publishedAfter, image: jpeg })
      .then((result) => ({ ...result, warning: undefined as string | undefined }))
      .catch((error: unknown) => ({ items: [] as RankedCreative[], quota: 0, checked: 0, warning: sourceMessage(error, "YouTube search failed. Try again shortly.") })),
    collectMetaAds(keywords)
      .then((items) => ({ items, warning: undefined as string | undefined }))
      .catch((error: unknown) => ({ items: [] as RankedCreative[], warning: sourceMessage(error, "Meta Ad Library search failed. Try again shortly.") })),
  ]);

  const warnings = [youtubeResult.warning, metaResult.warning].filter((warning): warning is string => Boolean(warning));
  const youtube = applyNormalizedScores(youtubeResult.items).sort((a, b) => b.score - a.score).slice(0, TOP_SOURCE);
  const meta = applyNormalizedScores(metaResult.items).sort((a, b) => b.score - a.score).slice(0, TOP_SOURCE);
  const combined = [...youtube, ...meta].sort((a, b) => b.normalizedScore - a.normalizedScore || b.score - a.score).slice(0, TOP_COMBINED);
  const result: FindResult = {
    product: title,
    brand,
    model,
    color,
    packagingText,
    keywords,
    quotaUsed: youtubeResult.quota,
    cached: false,
    checked: youtubeResult.checked,
    warnings,
    youtube,
    meta,
    combined,
  };
  writeCache(key, result);
  console.info(`[creatives] youtube quota ${result.quotaUsed}, meta ${metaResult.items.length}, matched videos ${youtube.length} for "${title}"`);
  return result;
}

function sourceMessage(error: unknown, fallback: string): string {
  if (error instanceof CreativeError) return error.message;
  return fallback;
}

async function loadImage(input: CreativeRequest): Promise<Buffer> {
  if (input.image) {
    if (!input.image.length || input.image.length > LIMITS.imageMaxBytes) {
      throw new CreativeError(input.image.length ? "Images can be at most 20 MB." : "That file is not a readable image.");
    }
    try {
      return await forVision(input.image);
    } catch {
      throw new CreativeError("That file is not a readable image.");
    }
  }
  const imageUrl = input.imageUrl?.trim() ?? "";
  if (!imageUrl) throw new CreativeError("Upload a product image or paste an image URL.");
  const tmp = tempPath("creatives", "images");
  try {
    await downloadToFile(imageUrl, tmp, LIMITS.imageMaxBytes, 30_000);
    return await forVision(tmp);
  } catch (error) {
    if (error instanceof TooLargeError) throw new CreativeError("Images can be at most 20 MB.");
    if (error instanceof FetchError) {
      throw new CreativeError(error.message.startsWith("Blocked") ? "That image address is not allowed." : "That image address could not be opened.");
    }
    throw new CreativeError("That file is not a readable image.");
  } finally {
    removeQuietly(tmp);
  }
}

function storeImage(jpeg: Buffer): void {
  const tmp = tempPath("creatives", "images");
  fs.writeFileSync(tmp, jpeg);
  commitFile("creatives", "images", tmp, "jpg");
}

function clip(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cleanKeywords(words: string[]): string[] {
  return [...new Set(words.map((word) => word.replace(/\s+/g, " ").trim()).filter((word) => word.length > 1 && word.length <= 120))].slice(0, 8);
}

function clampDays(days: number): number {
  if (!Number.isFinite(days) || days <= 0) return 180;
  return Math.min(365, Math.max(7, Math.round(days)));
}

function cacheKey(title: string, keywords: string[], shortsOnly: boolean, days: number): string {
  return JSON.stringify(["sources-v3", title.trim().toLowerCase(), shortsOnly ? "short" : "any", days, keywords.map((word) => word.toLowerCase()).sort()]);
}

let cacheReady = false;

function ensureCache() {
  const conn = db();
  if (!cacheReady) {
    conn.exec(`CREATE TABLE IF NOT EXISTS creative_cache (
      cache_key TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
    cacheReady = true;
  }
  return conn;
}

function readCache(key: string): FindResult | null {
  const conn = ensureCache();
  const row = conn.prepare("SELECT payload, created_at FROM creative_cache WHERE cache_key = ?").get(key) as
    | { payload: string; created_at: string }
    | undefined;
  if (!row) return null;
  if (Date.now() - Date.parse(row.created_at) > CACHE_MS) {
    conn.prepare("DELETE FROM creative_cache WHERE cache_key = ?").run(key);
    return null;
  }
  try {
    const saved = JSON.parse(row.payload) as FindResult;
    if (!saved?.product || !Array.isArray(saved.youtube) || !Array.isArray(saved.meta) || !Array.isArray(saved.combined)) return null;
    return { ...saved, quotaUsed: 0, cached: true, warnings: saved.warnings ?? [] };
  } catch {
    return null;
  }
}

function writeCache(key: string, result: FindResult): void {
  ensureCache()
    .prepare(
      `INSERT INTO creative_cache (cache_key, payload, created_at) VALUES (?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at`,
    )
    .run(key, JSON.stringify(result), new Date().toISOString());
}

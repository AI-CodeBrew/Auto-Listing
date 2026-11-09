import { config } from "../config";
import { noteRunningUsage } from "../repo";
import { saveSerpPreference, serpPreference, type SerpPreference } from "../settings";
import type { SerpPlan } from "../types";

/** One Google Images result from SerpAPI. */
export interface ImageHit {
  /** The full-size image file. */
  original: string;
  width: number | null;
  height: number | null;
  title: string;
  /** Name of the site the image is on. */
  source: string;
  /** The page the image is on. Empty when only the picture is kept. */
  pageUrl: string;
  /** A Google Lens picture. The product page is not kept. */
  imageOnly?: boolean;
}

interface SerpBody {
  error?: string;
  images_results?: {
    original?: string;
    original_width?: number;
    original_height?: number;
    title?: string;
    source?: string;
    link?: string;
  }[];
  visual_matches?: LensItem[];
  products?: LensItem[];
}

interface LensItem {
  title?: string;
  source?: string;
  link?: string;
  image?: string;
  thumbnail?: string;
  image_width?: number;
  image_height?: number;
}

const planCache = new Map<string, { at: number; plan: SerpPlan | null }>();
let stickyKey: { key: string; until: number } | null = null;

/** Drop the remembered key so the next search uses the choice just saved. */
export function clearSerpKeySticky(): void {
  stickyKey = null;
}

async function fetchPlan(key: string): Promise<SerpPlan | null> {
  const cached = planCache.get(key);
  if (cached && Date.now() - cached.at < 60_000) return cached.plan;
  try {
    const response = await fetch(`${config.serpApiBaseUrl()}/account.json?api_key=${encodeURIComponent(key)}`, {
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || !body || typeof body.error === "string") {
      planCache.set(key, { at: Date.now(), plan: cached?.plan ?? null });
      return cached?.plan ?? null;
    }
    const monthlyPrice = Number(body.plan_monthly_price);
    const planName = String(body.plan_name || "Free Plan");
    const plan: SerpPlan = {
      planName,
      free: monthlyPrice === 0 || /free/i.test(planName),
      searchesPerMonth: Number(body.searches_per_month) || 0,
      searchesLeft: Number(body.total_searches_left ?? body.plan_searches_left) || 0,
      thisMonthUsage: Number(body.this_month_usage) || 0,
      thisHourSearches: Number(body.this_hour_searches) || 0,
      hourlyLimit: Number(body.account_rate_limit_per_hour) || 0,
    };
    planCache.set(key, { at: Date.now(), plan });
    return plan;
  } catch {
    return cached?.plan ?? null;
  }
}

/** If auto is on and the active key has no searches left, start using the other key. */
function applyAutoSwitch(plans: [SerpPlan | null, SerpPlan | null]): SerpPreference {
  const pref = serpPreference();
  const keys = config.serpApiKeys();
  if (!pref.auto) return pref;
  const other = pref.active === 1 ? 2 : 1;
  const current = plans[pref.active - 1];
  const backup = plans[other - 1];
  if (!keys[pref.active - 1] || !current || current.searchesLeft > 0) return pref;
  if (!keys[other - 1] || !backup || backup.searchesLeft <= 0) return pref;
  return saveSerpPreference({ active: other, auto: true });
}

/** The key the next SerpAPI call should use. Empty when neither key is set. */
export async function resolveSerpKey(): Promise<string> {
  if (stickyKey && Date.now() < stickyKey.until) return stickyKey.key;
  const keys = config.serpApiKeys();
  const plans = (await Promise.all(keys.map((key) => (key ? fetchPlan(key) : Promise.resolve(null))))) as [SerpPlan | null, SerpPlan | null];
  const pref = applyAutoSwitch(plans);
  const key = keys[pref.active - 1] || keys[pref.active === 1 ? 1 : 0] || "";
  if (key) stickyKey = { key, until: Date.now() + 30_000 };
  return key;
}

export interface SerpKeyView {
  id: 1 | 2;
  configured: boolean;
  active: boolean;
  plan: SerpPlan | null;
}

/** Both keys, with allowance only. The key strings are never included. */
export async function serpOverview(): Promise<{ active: 1 | 2; auto: boolean; keys: SerpKeyView[] }> {
  await resolveSerpKey();
  const pref = serpPreference();
  const keys = config.serpApiKeys();
  const plans = await Promise.all(keys.map((key) => (key ? fetchPlan(key) : Promise.resolve(null))));
  return {
    active: pref.active,
    auto: pref.auto,
    keys: [1, 2].map((id) => ({
      id: id as 1 | 2,
      configured: Boolean(keys[id - 1]),
      active: pref.active === id && Boolean(keys[id - 1]),
      plan: plans[id - 1],
    })),
  };
}

/**
 * Live free-plan allowance for the key currently in use. The account call does not use a search.
 * Cached for a minute.
 */
export async function serpPlan(): Promise<SerpPlan | null> {
  const key = await resolveSerpKey();
  return key ? fetchPlan(key) : null;
}

/** Calls SerpAPI and turns every kind of failure into a message the user can act on. */
async function serpGetOnce(key: string, params: Record<string, string>): Promise<SerpBody> {
  const query = new URLSearchParams({ ...params, api_key: key });
  let response: Response;
  try {
    response = await fetch(`${config.serpApiBaseUrl()}/search.json?${query}`, { signal: AbortSignal.timeout(60_000) });
  } catch (error) {
    throw new Error(`Could not reach SerpAPI. Check your internet connection. ${error instanceof Error ? error.message : ""}`.trim());
  }

  const text = await response.text();
  let body: SerpBody = {};
  try {
    body = JSON.parse(text);
  } catch {
    // Handled below with the HTTP status.
  }

  if (response.status === 401 || /invalid api key/i.test(body.error ?? "")) {
    throw new Error("SerpAPI rejected the active key. Check SERPAPI_API_KEY and 2_SERPAPI_API_KEY in .env, then restart the app.");
  }
  if (response.status === 429 || /run out of searches|plan/i.test(body.error ?? "")) {
    const error = new Error(`SerpAPI has no searches left on your plan: ${body.error ?? "rate limit reached"}`);
    (error as Error & { exhausted?: boolean }).exhausted = true;
    throw error;
  }
  // "Google hasn't returned any results for this query." just means an empty page.
  if (body.error && !/hasn't returned any results/i.test(body.error)) throw new Error(`SerpAPI error: ${body.error}`);
  if (!response.ok && !body.error) throw new Error(`SerpAPI returned HTTP ${response.status}: ${text.slice(0, 200)}`);
  noteRunningUsage({ serpapi: 1 });
  return body;
}

async function serpGet(params: Record<string, string>): Promise<SerpBody> {
  const key = await resolveSerpKey();
  if (!key) throw new Error("SerpAPI key is missing. Add SERPAPI_API_KEY to .env and restart the app.");
  try {
    return await serpGetOnce(key, params);
  } catch (error) {
    const exhausted = error instanceof Error && (error as Error & { exhausted?: boolean }).exhausted;
    const pref = serpPreference();
    const keys = config.serpApiKeys();
    const other = keys[pref.active === 1 ? 1 : 0];
    if (!exhausted || !pref.auto || !other || other === key) throw error;
    saveSerpPreference({ active: pref.active === 1 ? 2 : 1, auto: true });
    clearSerpKeySticky();
    return serpGetOnce(other, params);
  }
}

const isWebUrl = (value: string | undefined): value is string => /^https?:\/\//i.test(value ?? "");

/**
 * Google Images through SerpAPI (https://serpapi.com). It is an API, so there is no CAPTCHA
 * and no robots.txt problem. One call returns up to about 100 images with their sizes and
 * source pages. Each call uses one search from the SerpAPI plan.
 */
export async function searchImages(query: string, pageIndex: number): Promise<ImageHit[]> {
  const body = await serpGet({
    engine: "google_images",
    q: query,
    ijn: String(pageIndex),
    // Large images only. Small ones would be rejected later anyway.
    tbs: "isz:l",
  });

  const hits: ImageHit[] = [];
  for (const item of body.images_results ?? []) {
    if (!isWebUrl(item.original)) continue;
    hits.push({
      original: item.original,
      width: item.original_width ?? null,
      height: item.original_height ?? null,
      title: (item.title ?? "").trim(),
      source: (item.source ?? "").trim(),
      pageUrl: isWebUrl(item.link) ? item.link : "",
    });
  }
  return hits;
}

/**
 * Sends the user's photo to SerpAPI. The returned id is used for the Lens search and expires in 10 minutes.
 * This upload is not a search.
 */
export async function uploadLensImage(jpeg: Buffer): Promise<string> {
  const form = new FormData();
  const key = await resolveSerpKey();
  if (!key) throw new Error("SerpAPI key is missing. Add SERPAPI_API_KEY to .env and restart the app.");
  form.append("api_key", key);
  form.append("image", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "product.jpg");
  let response: Response;
  try {
    response = await fetch(`${config.serpApiBaseUrl()}/image`, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
  } catch (error) {
    throw new Error(`Could not reach SerpAPI: ${error instanceof Error ? error.message : String(error)}`);
  }
  const body = (await response.json().catch(() => null)) as { image_id?: string; error?: string } | null;
  if (!response.ok || !body?.image_id) throw new Error(body?.error || `SerpAPI image upload returned HTTP ${response.status}`);
  return body.image_id;
}

/**
 * Google Lens visual matches for a photo uploaded to SerpAPI. Only the image file is kept.
 * The product page link is dropped. Costs one SerpAPI search.
 */
export async function lensSearch(imageId: string, limit = 20): Promise<ImageHit[]> {
  const body = await serpGet({ engine: "google_lens", type: "visual_matches", image_id: imageId, hl: "en" });

  const hits: ImageHit[] = [];
  const seen = new Set<string>();
  for (const item of body.visual_matches ?? []) {
    if (!isWebUrl(item.image) || seen.has(item.image)) continue;
    seen.add(item.image);
    hits.push({
      original: item.image,
      width: item.image_width ?? null,
      height: item.image_height ?? null,
      title: (item.title ?? "").trim(),
      source: (item.source ?? "").trim(),
      pageUrl: "",
      imageOnly: true,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

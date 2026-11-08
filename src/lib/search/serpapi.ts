import { config } from "../config";

/** One Google Images result from SerpAPI. */
export interface ImageHit {
  /** The full-size image file. */
  original: string;
  width: number | null;
  height: number | null;
  title: string;
  /** Name of the site the image is on. */
  source: string;
  /** The page the image is on. */
  pageUrl: string;
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
}

/** Calls SerpAPI and turns every kind of failure into a message the user can act on. */
async function serpGet(params: Record<string, string>): Promise<SerpBody> {
  const query = new URLSearchParams({ ...params, api_key: config.serpApiKey() });
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
    throw new Error("SerpAPI rejected SERPAPI_KEY. Check the key in .env and restart the app.");
  }
  if (response.status === 429 || /run out of searches|plan/i.test(body.error ?? "")) {
    throw new Error(`SerpAPI has no searches left on your plan: ${body.error ?? "rate limit reached"}`);
  }
  // "Google hasn't returned any results for this query." just means an empty page.
  if (body.error && !/hasn't returned any results/i.test(body.error)) throw new Error(`SerpAPI error: ${body.error}`);
  if (!response.ok && !body.error) throw new Error(`SerpAPI returned HTTP ${response.status}: ${text.slice(0, 200)}`);
  return body;
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
 * Google Lens: finds pictures that look like the photo at this PUBLIC address. Lens cannot
 * take the file itself. Visual matches and product matches are merged, de-duplicated, and
 * only http(s) pictures are kept. Costs one SerpAPI search.
 */
export async function lensSearch(photoUrl: string, limit = 20): Promise<ImageHit[]> {
  const body = await serpGet({ engine: "google_lens", type: "visual_matches", url: photoUrl, hl: "en" });

  const hits: ImageHit[] = [];
  const seen = new Set<string>();
  for (const item of [...(body.visual_matches ?? []), ...(body.products ?? [])]) {
    const picture = isWebUrl(item.image) ? item.image : isWebUrl(item.thumbnail) ? item.thumbnail : null;
    if (!picture || seen.has(picture)) continue;
    seen.add(picture);
    hits.push({
      original: picture,
      width: null,
      height: null,
      title: (item.title ?? "").trim(),
      source: (item.source ?? "").trim(),
      pageUrl: isWebUrl(item.link) ? item.link : "",
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

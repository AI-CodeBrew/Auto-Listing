/** Stores an uploaded photo is matched against. Twenty photos is the cap for one request. */
export const MARKETPLACES = [
  { id: "amazon", label: "Amazon", host: "amazon.com" },
  { id: "aliexpress", label: "AliExpress", host: "aliexpress.com" },
  { id: "alibaba", label: "Alibaba", host: "alibaba.com" },
] as const;

export type MarketplaceId = (typeof MARKETPLACES)[number]["id"];

export const MARKETPLACE_PHOTO_LIMIT = 20;

const HOST: Record<MarketplaceId, RegExp> = {
  amazon: /(^|\.)(media-amazon\.com|ssl-images-amazon\.com|images-amazon\.com|amazon\.(com|[a-z]{2,3}(\.[a-z]{2})?))$/i,
  aliexpress: /(^|\.)aliexpress\.[a-z.]+$/i,
  alibaba: /(^|\.)alibaba\.com$/i,
};

export interface MarketplaceHit {
  original: string;
  pageUrl?: string;
  source?: string;
}

function marketByHost(raw: string): (typeof MARKETPLACES)[number] | null {
  if (!raw) return null;
  let host = "";
  try {
    host = new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  return MARKETPLACES.find((market) => HOST[market.id].test(host)) ?? null;
}

/** Store name as SerpAPI reports it, when the picture URL itself is not on that store. */
function marketByName(source: string): (typeof MARKETPLACES)[number] | null {
  const text = source.toLowerCase();
  if (text.includes("aliexpress")) return MARKETPLACES[1];
  if (text.includes("alibaba")) return MARKETPLACES[2];
  if (text.includes("amazon")) return MARKETPLACES[0];
  return null;
}

export function marketplaceOfHit(hit: MarketplaceHit): (typeof MARKETPLACES)[number] | null {
  return marketByHost(hit.pageUrl ?? "") || marketByHost(hit.original) || marketByName(hit.source ?? "");
}

export function marketplaceLabel(pageUrl: string | null | undefined): string | null {
  if (!pageUrl) return null;
  return marketByHost(pageUrl)?.label ?? null;
}

/**
 * One photo from each store, then the next, until `limit`.
 * The same picture URL is kept once.
 */
export function takeMarketplacePhotos<T extends { original: string }>(groups: T[][], limit = MARKETPLACE_PHOTO_LIMIT): T[] {
  const seen = new Set<string>();
  const chosen: T[] = [];
  let index = 0;
  while (chosen.length < limit) {
    let added = false;
    for (const group of groups) {
      const hit = group[index];
      if (!hit || seen.has(hit.original)) continue;
      seen.add(hit.original);
      chosen.push(hit);
      added = true;
      if (chosen.length >= limit) break;
    }
    if (!added) break;
    index++;
  }
  return chosen;
}

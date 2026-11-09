import { config } from "../config";
import { scoreMetaAd } from "./scoring";
import { CreativeError, type MetaMetrics, type RankedCreative } from "./types";

const GRAPH = "https://graph.facebook.com/v21.0/ads_archive";
const COUNTRIES = ["DE", "FR", "GB", "IT", "ES", "NL"];
const FIELDS = [
  "id",
  "page_id",
  "page_name",
  "ad_snapshot_url",
  "ad_creative_bodies",
  "ad_creative_link_titles",
  "ad_creative_link_captions",
  "ad_delivery_start_time",
  "ad_delivery_stop_time",
  "publisher_platforms",
  "eu_total_reach",
  "languages",
].join(",");

interface MetaAd {
  id?: string;
  page_id?: string;
  page_name?: string;
  ad_snapshot_url?: string;
  ad_creative_bodies?: string[];
  ad_creative_link_titles?: string[];
  ad_delivery_start_time?: string;
  ad_delivery_stop_time?: string;
  publisher_platforms?: string[];
  eu_total_reach?: number | string;
}

interface MetaPage {
  data?: MetaAd[];
  paging?: { next?: string };
  error?: { message?: string; code?: number; type?: string };
}

/** One Ad Library search. Follows at most one extra page. */
export async function searchMetaAds(keyword: string): Promise<MetaAd[]> {
  const token = config.metaAccessToken();
  if (!token) throw new CreativeError("META_ACCESS_TOKEN is missing. Add it to .env and restart the app.", 500);
  const params = new URLSearchParams({
    search_terms: keyword,
    ad_type: "ALL",
    ad_active_status: "ALL",
    ad_reached_countries: JSON.stringify(COUNTRIES),
    publisher_platforms: JSON.stringify(["FACEBOOK", "INSTAGRAM"]),
    limit: "50",
    fields: FIELDS,
    access_token: token,
  });
  const ads: MetaAd[] = [];
  let next: string | null = `${GRAPH}?${params}`;
  for (let page = 0; page < 2 && next; page++) {
    const body = await metaGet(next);
    for (const ad of body.data ?? []) {
      if (ad.id) ads.push(ad);
    }
    const more = body.paging?.next;
    next = more && isGraphUrl(more) ? more : null;
  }
  return ads;
}

/** Searches every phrase at once and drops ads that have not run for 3 days. */
export async function collectMetaAds(keywords: string[]): Promise<RankedCreative[]> {
  const lists = await Promise.all(keywords.map((keyword) => searchMetaAds(keyword)));
  const byId = new Map<string, MetaAd>();
  for (const ad of lists.flat()) {
    if (ad.id && !byId.has(ad.id)) byId.set(ad.id, ad);
  }
  const ads = [...byId.values()];
  const groups = new Map<string, number>();
  for (const ad of ads) {
    const key = groupKey(ad);
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }

  const ranked: RankedCreative[] = [];
  for (const ad of ads) {
    if (!ad.id) continue;
    const body = (ad.ad_creative_bodies?.[0] ?? "").replace(/\s+/g, " ").trim();
    const duplicates = groups.get(groupKey(ad)) ?? 1;
    const reach = numberOf(ad.eu_total_reach);
    const scored = scoreMetaAd({
      start: ad.ad_delivery_start_time ?? "",
      stop: ad.ad_delivery_stop_time || null,
      reach,
      duplicates,
    });
    if (!scored) continue;
    const platforms = (ad.publisher_platforms ?? []).filter((name): name is "FACEBOOK" | "INSTAGRAM" => name === "FACEBOOK" || name === "INSTAGRAM");
    const shown: ("FACEBOOK" | "INSTAGRAM")[] = platforms.length ? platforms : ["FACEBOOK"];
    const instagramOnly = shown.includes("INSTAGRAM") && !shown.includes("FACEBOOK");
    const title = (ad.ad_creative_link_titles?.[0] || body || "Untitled ad").replace(/\s+/g, " ").trim();
    const metrics: MetaMetrics = {
      daysRunning: Math.max(3, Math.round(scored.daysRunning)),
      isActive: scored.isActive,
      reach,
      duplicates,
      platforms: [...shown],
    };
    ranked.push({
      source: instagramOnly ? "instagram" : "facebook",
      id: ad.id,
      title: title.slice(0, 300),
      text: body,
      author: ad.page_name?.trim() || "Unknown page",
      url: ad.ad_snapshot_url || `https://www.facebook.com/ads/library/?id=${encodeURIComponent(ad.id)}`,
      thumbnail: "",
      startedAt: ad.ad_delivery_start_time ?? "",
      metrics,
      score: scored.score,
      normalizedScore: 0,
    });
  }
  return ranked.sort((a, b) => b.score - a.score);
}

async function metaGet(url: string): Promise<MetaPage> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new CreativeError("Could not reach the Meta Ad Library. Check your internet connection.", 502);
  }
  const raw = await response.text();
  let body: MetaPage = {};
  try {
    body = raw ? (JSON.parse(raw) as MetaPage) : {};
  } catch {
    body = {};
  }
  if (!response.ok || body.error) {
    const code = body.error?.code ?? response.status;
    const message = body.error?.message ?? "";
    console.info(`[creatives] meta ${code}`);
    if (code === 190) throw new CreativeError("Meta token expired, refresh it", 502);
    if (code === 10 || code === 200 || code === 270 || /permission|not authorized|identity|ads_archive|verify your identity/i.test(message)) {
      throw new CreativeError("Meta Ad Library access not approved yet", 502);
    }
    throw new CreativeError("Meta Ad Library search failed. Try again shortly.", 502);
  }
  return body;
}

function groupKey(ad: MetaAd): string {
  return `${ad.page_id ?? ""}::${ad.ad_creative_bodies?.[0] ?? ""}`;
}

function isGraphUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname === "graph.facebook.com";
  } catch {
    return false;
  }
}

function numberOf(value: number | string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

import { matchProductThumbnails, type VisionImage } from "../ai";
import { config } from "../config";
import { forVision } from "../media/images";
import { removeQuietly, tempPath } from "../storage";
import { downloadToFile } from "../web/net";
import { scoreVideo } from "./scoring";
import { CreativeError, type RankedCreative, type YoutubeMetrics } from "./types";

/** search.list costs 100 units. videos.list costs 1 unit per call, not per video. */
const SEARCH_UNITS = 100;
const STATS_UNITS = 1;
const MIN_VIEWS = 1000;
const PER_SEARCH = 30;
const THUMBNAILS_TO_CHECK = 30;

interface YtErrorBody {
  error?: { message?: string; errors?: { reason?: string }[] };
}

interface SearchBody {
  items?: { id?: { videoId?: string } }[];
}

interface VideoItem {
  id?: string;
  snippet?: {
    title?: string;
    description?: string;
    channelTitle?: string;
    publishedAt?: string;
    thumbnails?: Record<string, { url?: string }>;
  };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
}

interface VideosBody {
  items?: VideoItem[];
}

interface ScoredVideo extends RankedCreative {
  metrics: YoutubeMetrics;
}

/** Searches each phrase, scores the videos, and keeps thumbnails that show the same product. */
export async function collectYoutube(
  keywords: string[],
  options: { shortsOnly: boolean; publishedAfter: string; image: Buffer },
): Promise<{ items: RankedCreative[]; quota: number; checked: number }> {
  let quota = 0;
  try {
    const search = await searchVideos(keywords, options);
    quota += search.quota;
    const stats = search.ids.length ? await getStats(search.ids) : { videos: [], quota: 0 };
    quota += stats.quota;
    const ranked = stats.videos
      .map((item) => toCreative(item))
      .filter((hit): hit is ScoredVideo => hit !== null && hit.metrics.views >= MIN_VIEWS)
      .sort((a, b) => b.score - a.score);
    const candidates = ranked.slice(0, THUMBNAILS_TO_CHECK);
    const matched = new Set(await confirmMatches(options.image, candidates));
    const items = candidates.filter((hit) => matched.has(hit.id));
    return { items, quota, checked: candidates.length };
  } catch (error) {
    if (quota > 0) console.info(`[creatives] youtube quota used ${quota} before failure`);
    throw error;
  }
}

export async function searchVideos(
  keywords: string[],
  options: { shortsOnly: boolean; publishedAfter: string },
): Promise<{ ids: string[]; quota: number }> {
  const ids: string[] = [];
  const seen = new Set<string>();
  let quota = 0;
  for (const keyword of keywords) {
    const params: Record<string, string> = {
      part: "id",
      q: keyword,
      type: "video",
      order: "viewCount",
      maxResults: String(PER_SEARCH),
      publishedAfter: options.publishedAfter,
    };
    if (options.shortsOnly) params.videoDuration = "short";
    const body = (await youtube("search", params)) as SearchBody;
    quota += SEARCH_UNITS;
    for (const item of body.items ?? []) {
      const id = item.id?.videoId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return { ids, quota };
}

export async function getStats(ids: string[]): Promise<{ videos: VideoItem[]; quota: number }> {
  const videos: VideoItem[] = [];
  let quota = 0;
  for (let start = 0; start < ids.length; start += 50) {
    const body = (await youtube("videos", {
      part: "snippet,statistics,contentDetails",
      id: ids.slice(start, start + 50).join(","),
    })) as VideosBody;
    quota += STATS_UNITS;
    for (const item of body.items ?? []) {
      if (item.id) videos.push(item);
    }
  }
  return { videos, quota };
}

async function confirmMatches(jpeg: Buffer, candidates: ScoredVideo[]): Promise<string[]> {
  const product: VisionImage = { data: jpeg };
  const thumbs: { id: string; data: Buffer }[] = [];
  const queue = candidates.filter((hit) => hit.thumbnail);
  let cursor = 0;
  async function take(): Promise<void> {
    while (cursor < queue.length) {
      const hit = queue[cursor++];
      const data = await thumbnailJpeg(hit.thumbnail);
      if (data) thumbs.push({ id: hit.id, data });
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, () => take()));
  if (!thumbs.length && queue.length) {
    throw new CreativeError("The video thumbnails could not be checked. Try again.", 502);
  }
  return matchProductThumbnails(product, thumbs);
}

async function thumbnailJpeg(url: string): Promise<Buffer | null> {
  const tmp = tempPath("creatives", "images");
  try {
    await downloadToFile(url, tmp, 2_000_000, 15_000);
    return await forVision(tmp);
  } catch {
    return null;
  } finally {
    removeQuietly(tmp);
  }
}

function toCreative(item: VideoItem): ScoredVideo | null {
  const views = numberOf(item.statistics?.viewCount);
  const likes = numberOf(item.statistics?.likeCount);
  const comments = numberOf(item.statistics?.commentCount);
  const publishedAt = item.snippet?.publishedAt ?? "";
  const scored = scoreVideo({ views, likes, comments, publishedAt });
  if (!item.id || !scored) return null;
  const thumbs = item.snippet?.thumbnails ?? {};
  const title = item.snippet?.title?.trim() || "Untitled video";
  return {
    source: "youtube",
    id: item.id,
    title,
    text: item.snippet?.description?.trim() || title,
    author: item.snippet?.channelTitle?.trim() || "Unknown channel",
    url: `https://www.youtube.com/watch?v=${encodeURIComponent(item.id)}`,
    thumbnail: thumbs.medium?.url || thumbs.high?.url || thumbs.default?.url || thumbs.standard?.url || "",
    startedAt: publishedAt,
    metrics: {
      views,
      likes,
      viewsPerDay: round(scored.viewsPerDay, 1),
      engagementPct: round(scored.engagement * 100, 2),
    },
    score: scored.score,
    normalizedScore: 0,
  };
}

async function youtube(path: "search" | "videos", params: Record<string, string>): Promise<unknown> {
  const key = config.youtubeApiKey();
  if (!key) throw new CreativeError("YOUTUBE_API_KEY is missing. Add it to .env and restart the app.", 500);
  const url = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  url.searchParams.set("key", key);

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new CreativeError("Could not reach YouTube. Check your internet connection.", 502);
  }
  const raw = await response.text();
  let body: YtErrorBody = {};
  try {
    body = raw ? (JSON.parse(raw) as YtErrorBody) : {};
  } catch {
    body = {};
  }
  if (!response.ok) {
    const reason = body.error?.errors?.[0]?.reason ?? "";
    const message = body.error?.message ?? "";
    console.info(`[creatives] youtube ${path} ${response.status} ${reason || "error"}`);
    if (response.status === 403 && (reason === "quotaExceeded" || /quota/i.test(message))) {
      throw new CreativeError("Daily limit reached, try again tomorrow.", 429);
    }
    if (reason === "keyInvalid" || reason === "accessNotConfigured" || /API key/i.test(message)) {
      throw new CreativeError("YouTube rejected YOUTUBE_API_KEY. Check the key in .env and restart the app.", 502);
    }
    throw new CreativeError("YouTube search failed. Try again shortly.", 502);
  }
  return body;
}

function numberOf(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

import type { RankedCreative } from "./types";

/** YouTube: views per day, with a bump for likes and comments. */
export function scoreVideo(
  video: { views: number; likes: number; comments: number; publishedAt: string },
  now = Date.now(),
): { daysLive: number; viewsPerDay: number; engagement: number; score: number } | null {
  const published = Date.parse(video.publishedAt);
  if (!Number.isFinite(published)) return null;
  const daysLive = Math.max(1, (now - published) / 86_400_000);
  const viewsPerDay = video.views / daysLive;
  const engagement = video.views > 0 ? (video.likes + video.comments * 2) / video.views : 0;
  const score = viewsPerDay * (1 + engagement * 10);
  return { daysLive, viewsPerDay, engagement, score };
}

/**
 * Meta: ads that keep running, still active, with reach, and that a page has copied,
 * score higher. Ads newer than 3 days are not scored.
 */
export function scoreMetaAd(
  ad: { start: string; stop: string | null; reach: number; duplicates: number },
  now = Date.now(),
): { daysRunning: number; isActive: boolean; score: number } | null {
  const start = Date.parse(ad.start);
  if (!Number.isFinite(start)) return null;
  const parsedStop = ad.stop ? Date.parse(ad.stop) : now;
  const end = Number.isFinite(parsedStop) ? parsedStop : now;
  const daysRunning = Math.max(1, (end - start) / 86_400_000);
  if (daysRunning < 3) return null;
  const isActive = !ad.stop;
  const score = daysRunning * (isActive ? 1.5 : 1) * Math.log10(ad.reach + 10) * (1 + ad.duplicates * 0.2);
  return { daysRunning, isActive, score };
}

/** Scales one source's scores to 0–100 so YouTube and Meta can share a list. */
export function applyNormalizedScores(items: RankedCreative[]): RankedCreative[] {
  if (!items.length) return items;
  const scores = items.map((item) => item.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const span = max - min;
  return items.map((item) => ({
    ...item,
    normalizedScore: span === 0 ? 100 : Math.round(((item.score - min) / span) * 1000) / 10,
  }));
}

import robotsParser from "robots-parser";
import { config, USER_AGENT_TOKEN } from "../config";
import { safeFetch, sleep } from "./net";

type Parsed = { isAllowed(url: string, ua?: string): boolean | undefined; getCrawlDelay(ua?: string): number | undefined };

const cache = new Map<string, { rules: Parsed | "allow-all" | "deny-all"; at: number }>();
const lastRequest = new Map<string, number>();
const CACHE_MS = 60 * 60_000;
const MAX_CRAWL_DELAY_MS = 10_000;

async function rulesFor(origin: string) {
  const hit = cache.get(origin);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rules;

  let rules: Parsed | "allow-all" | "deny-all";
  try {
    const { response } = await safeFetch(`${origin}/robots.txt`, {}, 10_000);
    if (response.ok) {
      rules = robotsParser(`${origin}/robots.txt`, await response.text()) as unknown as Parsed;
    } else {
      await response.body?.cancel();
      // RFC 9309: 4xx means no rules apply. 5xx means assume everything is disallowed.
      rules = response.status >= 500 ? "deny-all" : "allow-all";
    }
  } catch {
    rules = "deny-all"; // Could not read the rules, so do not assume permission.
  }
  cache.set(origin, { rules, at: Date.now() });
  return rules;
}

export async function isAllowedByRobots(url: string): Promise<boolean> {
  const rules = await rulesFor(new URL(url).origin);
  if (rules === "allow-all") return true;
  if (rules === "deny-all") return false;
  return rules.isAllowed(url, USER_AGENT_TOKEN) !== false;
}

/** Waits for the configured delay, or the site's Crawl-delay if that is longer. */
export async function politeWait(url: string, baseDelayMs = config.requestDelayMs()): Promise<void> {
  const origin = new URL(url).origin;
  const rules = await rulesFor(origin);
  const crawlDelayS = typeof rules === "object" ? Number(rules.getCrawlDelay(USER_AGENT_TOKEN) || 0) : 0;
  const delay = Math.max(baseDelayMs, Math.min(crawlDelayS * 1000, MAX_CRAWL_DELAY_MS));
  const wait = (lastRequest.get(origin) ?? 0) + delay - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequest.set(origin, Date.now());
}

export function clearRobotsCache(): void {
  cache.clear();
  lastRequest.clear();
}

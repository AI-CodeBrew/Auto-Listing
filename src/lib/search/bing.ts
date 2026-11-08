import { config } from "../config";
import { openPage, withPage } from "../web/browser";
import { SearchDisallowedError } from "../web/errors";
import { isAllowedByRobots, politeWait } from "../web/robots";
import type { SearchProvider } from "./index";

const COLLECT_LINKS = `[...document.querySelectorAll('li.b_algo h2 a, li.b_algo .b_title a')].map(a => a.href)`;

/**
 * Bing wraps results in bing.com/ck/a?...&u=a1<base64url>. robots.txt also forbids
 * /ck/, so the target is decoded here and the redirect is never followed.
 */
export function unwrapBingLink(href: string): string | null {
  try {
    const url = new URL(href);
    if (!/(^|\.)bing\.com$/i.test(url.hostname)) return href;
    const encoded = url.searchParams.get("u");
    if (!encoded?.startsWith("a1")) return null;
    const decoded = Buffer.from(encoded.slice(2), "base64url").toString("utf8");
    return /^https?:\/\//i.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

export const bingProvider: SearchProvider = {
  name: "Bing",
  async search(query, offset) {
    const params = new URLSearchParams({ q: query });
    if (offset > 0) params.set("first", String(offset + 1));
    const url = `${config.bingBaseUrl()}/search?${params}`;

    // The same robots.txt rule applies here as everywhere else.
    if (!(await isAllowedByRobots(url))) throw new SearchDisallowedError(url);

    await politeWait(url);
    return withPage(async (page) => {
      await openPage(page, url);
      const hrefs = (await page.evaluate(COLLECT_LINKS)) as string[];
      return hrefs.map(unwrapBingLink).filter((link): link is string => Boolean(link));
    });
  },
};

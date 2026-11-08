import { bingProvider } from "./bing";

/**
 * Search module for the no-SerpAPI path. To replace Bing, write another SearchProvider and
 * return it here. Nothing else in the app knows which provider is used. (With a SerpAPI
 * key the app does not search pages at all. It uses Google Images, see serpapi.ts.)
 */
export interface SearchProvider {
  name: string;
  /**
   * Returns result URLs for the query.
   * @throws BlockedError when the provider shows a CAPTCHA or bot block.
   * @throws SearchDisallowedError when robots.txt forbids the search page.
   */
  search(query: string, offset: number): Promise<string[]>;
}

export function getSearchProvider(): SearchProvider {
  return bingProvider;
}

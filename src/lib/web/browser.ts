import { chromium, type Browser, type Page, type Response as PwResponse } from "playwright";
import { LIMITS } from "../config";
import { BlockedError } from "./errors";
import { isPublicUrl } from "./net";

/**
 * Plain headless Chromium, one page at a time. It uses Chromium's own defaults:
 * no stealth plugins, spoofed fingerprint, proxies or CAPTCHA solving. If a site
 * refuses us, we stop and tell the user.
 */
const holder = globalThis as unknown as { __plaBrowser?: Promise<Browser>; __plaPageLock?: Promise<unknown> };

function getBrowser(): Promise<Browser> {
  if (!holder.__plaBrowser) {
    holder.__plaBrowser = chromium.launch({ headless: true }).then((browser) => {
      browser.on("disconnected", () => {
        holder.__plaBrowser = undefined;
      });
      return browser;
    });
    holder.__plaBrowser.catch(() => {
      holder.__plaBrowser = undefined;
    });
  }
  return holder.__plaBrowser;
}

export async function closeBrowser(): Promise<void> {
  const browser = await holder.__plaBrowser?.catch(() => undefined);
  holder.__plaBrowser = undefined;
  await browser?.close().catch(() => undefined);
}

/** Runs fn with a fresh isolated page. Calls wait their turn, so only one page is ever open. */
export function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const run = async () => {
    const browser = await getBrowser();
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
    });
    context.setDefaultTimeout(LIMITS.pageTimeoutMs);
    context.setDefaultNavigationTimeout(LIMITS.pageTimeoutMs);
    // Untrusted pages may not reach local services, including this app's API.
    await context.route("**/*", async (route) => {
      const request = route.request();
      if (["media", "font", "websocket"].includes(request.resourceType())) return route.abort();
      if (request.url().startsWith("data:") || request.url().startsWith("blob:")) return route.continue();
      return (await isPublicUrl(request.url())) ? route.continue() : route.abort("blockedbyclient");
    });
    try {
      const page = await context.newPage();
      return await fn(page);
    } finally {
      await context.close().catch(() => undefined);
    }
  };
  const next = (holder.__plaPageLock ?? Promise.resolve()).then(run, run);
  holder.__plaPageLock = next.catch(() => undefined);
  return next;
}

const CHALLENGE_TEXT = [
  /verify (that )?you('| a)re (a )?human/i,
  /are you (a )?(human|robot)/i,
  /robot or human/i,
  /(press|activate) (&|and) hold/i,
  /i('| a)m not a robot/i,
  /complete the (security )?(check|challenge)/i,
  /checking (if the site connection is secure|your browser)/i,
  /unusual traffic/i,
  /automated (requests|queries|access)/i,
  /access (to this page )?(has been )?denied/i,
  /pardon our interruption/i,
  /enter the characters you see/i,
  /please solve (this|the) (puzzle|captcha)/i,
  /\bcaptcha\b/i,
];
const CHALLENGE_TITLE = /just a moment|attention required|access denied|security check|are you a (human|robot)|robot or human|captcha|robot check/i;
const CHALLENGE_URL = /\/(captcha|challenge|sorry|cdn-cgi\/challenge-platform|distil_r_captcha)|[?&](captcha|challenge)=/i;
const CHALLENGE_FRAME = 'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], iframe[src*="captcha"]';

/** Returns a reason when the loaded page is a CAPTCHA or bot-block page, otherwise null. */
export async function detectBlock(page: Page, response: PwResponse | null): Promise<string | null> {
  const status = response?.status() ?? 0;
  const url = page.url();
  const title = await page.title().catch(() => "");
  const text = await page
    .evaluate("(document.body ? document.body.innerText : '').slice(0, 4000)")
    .then(String)
    .catch(() => "");
  const shortPage = text.trim().length < 800;

  if (CHALLENGE_URL.test(new URL(url).pathname + new URL(url).search)) return "the site redirected to a challenge page";
  if (CHALLENGE_TITLE.test(title)) return `the page title is "${title}"`;
  if (status === 429) return "the site answered HTTP 429 (too many requests)";
  if (status === 403) return "the site answered HTTP 403 (forbidden)";
  // Long pages often carry a hidden reCAPTCHA on a contact form or mention the
  // word in a footer, so frames and text only count when they dominate the page.
  // A 503 alone usually means the site is down, not that it is blocking us.
  if (shortPage) {
    const visibleFrame = await page.locator(CHALLENGE_FRAME).first().isVisible().catch(() => false);
    if (visibleFrame) return "the page shows a CAPTCHA";
    if (CHALLENGE_TEXT.some((pattern) => pattern.test(text))) return "the page asks for a human check";
  }
  return null;
}

/** Opens a URL and throws BlockedError if the result is a challenge page. */
export async function openPage(page: Page, url: string): Promise<PwResponse | null> {
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: LIMITS.pageTimeoutMs });
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
  const reason = await detectBlock(page, response);
  if (reason) throw new BlockedError(reason, url);
  return response;
}

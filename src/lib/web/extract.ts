import type { Page } from "playwright";
import { LIMITS } from "../config";
import { toPlainText } from "../sanitize";
import { domainOf } from "./urls";

export interface ImageCandidate {
  /** URLs to try in order. The likely full-size version comes first. */
  urls: string[];
  alt: string;
}

export interface PageData {
  url: string;
  title: string;
  description: string;
  text: string;
  seller: string;
  images: ImageCandidate[];
  videos: string[];
  screenshot: Buffer | null;
}

interface RawPage {
  url: string;
  documentTitle: string;
  jsonLd: string[];
  og: Record<string, string[]>;
  h1: string;
  mainText: string;
  domImages: { src: string; srcset: string; zoom: string; link: string; alt: string; naturalWidth: number; naturalHeight: number; width: number; height: number }[];
  videoSources: string[];
  frames: string[];
}

/** Runs inside the page. A plain string, so bundlers cannot inject helpers into it. */
const COLLECT_SCRIPT = `(() => {
  const meta = {};
  for (const el of document.querySelectorAll('meta[property^="og:"], meta[name^="og:"]')) {
    const key = el.getAttribute('property') || el.getAttribute('name');
    const value = el.getAttribute('content');
    if (key && value) (meta[key.toLowerCase()] = meta[key.toLowerCase()] || []).push(value);
  }
  const main = document.querySelector('main, [role="main"], article, #product, .product') || document.body;
  const clone = main ? main.cloneNode(true) : null;
  if (clone) for (const el of clone.querySelectorAll('script, style, noscript, nav, footer, header, form, aside')) el.remove();
  const zoomAttrs = ['data-zoom-image', 'data-zoom', 'data-large_image', 'data-large-image', 'data-old-hires', 'data-full', 'data-original', 'data-src'];
  const domImages = [];
  for (const img of document.images) {
    let zoom = '';
    for (const attr of zoomAttrs) { const v = img.getAttribute(attr); if (v) { zoom = v; break; } }
    const parent = img.closest('a[href]');
    const link = parent && /\\.(jpe?g|png|webp)(\\?|$)/i.test(parent.getAttribute('href') || '') ? parent.href : '';
    const picture = img.closest('picture');
    let srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset') || '';
    if (picture) for (const s of picture.querySelectorAll('source[srcset]')) srcset += ',' + s.getAttribute('srcset');
    const rect = img.getBoundingClientRect();
    domImages.push({ src: img.currentSrc || img.src || '', srcset, zoom, link, alt: img.alt || '',
      naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, width: rect.width, height: rect.height });
  }
  const videoSources = [];
  for (const v of document.querySelectorAll('video')) {
    if (v.src) videoSources.push(v.src);
    for (const s of v.querySelectorAll('source[src]')) videoSources.push(s.src);
  }
  const frames = [...document.querySelectorAll('iframe[src], iframe[data-src]')].map(f => f.src || f.getAttribute('data-src') || '');
  return {
    url: location.href,
    documentTitle: document.title || '',
    jsonLd: [...document.querySelectorAll('script[type="application/ld+json"]')].map(s => s.textContent || ''),
    og: meta,
    h1: (document.querySelector('h1') || {}).innerText || '',
    mainText: clone ? (clone.innerText || clone.textContent || '').slice(0, 60000) : '',
    domImages, videoSources, frames,
  };
})()`;

const SCROLL_SCRIPT = `new Promise((resolve) => {
  let y = 0; const step = Math.max(window.innerHeight, 600); const max = Math.min(document.body ? document.body.scrollHeight : 0, 8000);
  const timer = setInterval(() => { y += step; window.scrollTo(0, y); if (y >= max) { clearInterval(timer); window.scrollTo(0, 0); resolve(null); } }, 80);
})`;

type JsonValue = unknown;

function typeMatches(node: Record<string, unknown>, names: string[]): boolean {
  const type = node["@type"];
  const list = Array.isArray(type) ? type : [type];
  return list.some((t) => typeof t === "string" && names.some((n) => t.toLowerCase().endsWith(n)));
}

/** Depth-first walk over parsed JSON-LD, following @graph and nested values. */
function collectNodes(value: JsonValue, names: string[], out: Record<string, unknown>[], depth = 0): void {
  if (!value || typeof value !== "object" || depth > 8) return;
  if (Array.isArray(value)) {
    for (const item of value) collectNodes(item, names, out, depth + 1);
    return;
  }
  const node = value as Record<string, unknown>;
  if (typeMatches(node, names)) out.push(node);
  for (const child of Object.values(node)) collectNodes(child, names, out, depth + 1);
}

function firstString(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return firstString(value[0]);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return firstString(obj.name ?? obj.url ?? obj.contentUrl ?? "");
  }
  return "";
}

function jsonLdImages(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(jsonLdImages);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return jsonLdImages(obj.contentUrl ?? obj.url ?? []);
  }
  return [];
}

function sellerFromProduct(product: Record<string, unknown>): string {
  const direct = firstString(product.seller);
  if (direct) return direct;
  const offers = Array.isArray(product.offers) ? product.offers : [product.offers];
  for (const offer of offers) {
    if (offer && typeof offer === "object") {
      const seller = firstString((offer as Record<string, unknown>).seller);
      if (seller) return seller;
    }
  }
  return "";
}

/** Picks the widest entry in a srcset. */
export function largestFromSrcset(srcset: string): string | null {
  let best: string | null = null;
  let bestSize = -1;
  for (const part of srcset.split(/,\s+|,(?=https?:|\/)/)) {
    const [url, descriptor] = part.trim().split(/\s+/);
    if (!url) continue;
    const match = descriptor?.match(/^([\d.]+)([wx])$/);
    const size = match ? Number(match[1]) * (match[2] === "x" ? 1000 : 1) : 1;
    if (size > bestSize) {
      bestSize = size;
      best = url;
    }
  }
  return best;
}

/** Guesses the full-size URL for common CDN naming patterns. The original stays as a fallback. */
export function fullSizeGuesses(raw: string): string[] {
  const guesses: string[] = [];
  try {
    const url = new URL(raw);
    const path = url.pathname;
    const stripped = path
      // Shopify: photo_400x400.jpg, photo_small.jpg
      .replace(/_(\d+x\d*|\d*x\d+|pico|icon|thumb|small|compact|medium|large|grande|master)(@\dx)?(?=\.\w+$)/i, "")
      // WordPress: photo-300x300.jpg
      .replace(/-\d{2,4}x\d{2,4}(?=\.\w+$)/, "")
      // Amazon: photo._AC_SX300_.jpg
      .replace(/\._[A-Z0-9_,]+_(?=\.\w+$)/i, "");
    const next = new URL(url);
    next.pathname = stripped;
    for (const key of ["width", "height", "w", "h", "size", "resize", "fit"]) next.searchParams.delete(key);
    if (next.toString() !== raw) guesses.push(next.toString());
  } catch {
    return [];
  }
  return guesses;
}

const ICON_URL = /(^|[\/_.-])(logo|logos|icon|icons|favicon|sprite|badge|avatar|payment|paypal|visa|mastercard|placeholder|spinner|loader)([\/_.-]|\d|$)/i;

export function looksLikeIconOrLogo(url: string, alt = ""): boolean {
  try {
    const parsed = new URL(url);
    if (/\.(svg|ico)$/i.test(parsed.pathname)) return true;
    return ICON_URL.test(parsed.pathname) || /\b(logo|icon)\b/i.test(alt);
  } catch {
    return true;
  }
}

function buildImages(raw: RawPage, jsonLd: string[], og: string[]): ImageCandidate[] {
  const out: ImageCandidate[] = [];
  const seen = new Set<string>();
  const add = (urlValue: string, alt: string, extra: string[] = []) => {
    let absolute: string;
    try {
      absolute = new URL(urlValue, raw.url).toString();
    } catch {
      return;
    }
    if (!/^https?:/.test(absolute) || looksLikeIconOrLogo(absolute, alt) || seen.has(absolute)) return;
    const absoluteExtra = extra.flatMap((u) => {
      try {
        return [new URL(u, raw.url).toString()];
      } catch {
        return [];
      }
    });
    const urls = [...new Set([...absoluteExtra, ...fullSizeGuesses(absolute), absolute])];
    // Thumbnails of one picture share a full-size URL. Without this, copies of a
    // single image could use up the whole per-page limit.
    if (seen.has(urls[0])) return;
    urls.forEach((u) => seen.add(u));
    out.push({ urls, alt: toPlainText(alt) });
  };
  for (const url of jsonLd) add(url, "");
  for (const url of og) add(url, "");
  const dom = raw.domImages
    .filter((img) => img.src || img.srcset || img.zoom)
    // Skip images that loaded small unless a larger version is on offer.
    .filter((img) => Math.max(img.naturalWidth, img.width) >= 300 || img.srcset || img.zoom || img.link)
    .sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight);
  for (const img of dom) {
    const large = img.srcset ? largestFromSrcset(img.srcset) : null;
    const best = [img.zoom, img.link, large].filter((v): v is string => Boolean(v));
    add(img.src || best[0], img.alt, best);
  }
  return out.slice(0, LIMITS.imagesPerPage);
}

/** Pulls product data from the open page in priority order: JSON-LD, Open Graph, then the DOM. */
export async function extractPage(page: Page): Promise<PageData> {
  await page.evaluate(SCROLL_SCRIPT).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
  const raw = (await page.evaluate(COLLECT_SCRIPT)) as RawPage;
  const screenshot = await page.screenshot({ type: "jpeg", quality: 70 }).catch(() => null);

  const products: Record<string, unknown>[] = [];
  const videoObjects: Record<string, unknown>[] = [];
  for (const block of raw.jsonLd) {
    try {
      const parsed = JSON.parse(block) as JsonValue;
      collectNodes(parsed, ["product", "productgroup"], products);
      collectNodes(parsed, ["videoobject"], videoObjects);
    } catch {
      // Sites often publish broken JSON-LD. Fall through to Open Graph and the DOM.
    }
  }
  const product = products[0];
  const og = (key: string) => raw.og[key]?.[0] ?? "";

  const title = toPlainText((product && firstString(product.name)) || og("og:title") || raw.h1 || raw.documentTitle);
  const description = toPlainText((product && firstString(product.description)) || og("og:description"));
  const mainText = toPlainText(raw.mainText);
  const text = [description, mainText].filter(Boolean).join("\n\n").slice(0, LIMITS.sourceTextChars);
  const seller =
    toPlainText(product ? sellerFromProduct(product) : "") || toPlainText(og("og:site_name")) || domainOf(raw.url);

  const videos: string[] = [];
  for (const node of videoObjects) {
    for (const key of ["contentUrl", "embedUrl", "url"]) {
      const value = firstString(node[key]);
      if (value) videos.push(value);
    }
  }
  for (const key of ["og:video", "og:video:url", "og:video:secure_url"]) videos.push(...(raw.og[key] ?? []));
  videos.push(...raw.videoSources, ...raw.frames);
  const absoluteVideos = [
    ...new Set(
      videos.flatMap((value) => {
        try {
          return [new URL(value, raw.url).toString()];
        } catch {
          return [];
        }
      }),
    ),
  ];

  return {
    url: raw.url,
    title,
    description,
    text,
    seller,
    images: buildImages(raw, product ? jsonLdImages(product.image) : [], raw.og["og:image"] ?? []),
    videos: absoluteVideos,
    screenshot,
  };
}

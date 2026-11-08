const SOCIAL_HOSTS = [
  "facebook.com", "fb.com", "fb.watch", "instagram.com", "tiktok.com", "twitter.com", "x.com",
  "pinterest.com", "linkedin.com", "reddit.com", "youtube.com", "youtu.be", "vimeo.com",
  "snapchat.com", "threads.net", "tumblr.com", "quora.com", "discord.com", "telegram.org",
  "whatsapp.com", "wikipedia.org",
];
const BLOG_HOSTS = ["medium.com", "blogspot.com", "wordpress.com", "substack.com", "wixsite.com", "weebly.com", "ghost.io"];
const BLOG_PATH = /\/(blog|blogs|news|article|articles|forum|forums|community|magazine|guide|guides|review|reviews|how-to|wiki)(\/|$)/i;
const BLOG_HOST_PREFIX = /^(blog|news|forum|community|magazine|wiki)\./i;
const TRACKING_PARAM = /^(utm_.+|gclid|fbclid|msclkid|mc_cid|mc_eid|ref|ref_|tag|cid|sr|qid|spm|igshid|_ga|_gl)$/i;

function hostMatches(host: string, list: string[]): boolean {
  return list.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

/** Returns why a URL should not be used as a product page, or null if it is fine. */
export function exclusionReason(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Not a valid URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Not a web page";
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (hostMatches(host, SOCIAL_HOSTS)) return "Social media page";
  if (hostMatches(host, BLOG_HOSTS) || BLOG_HOST_PREFIX.test(host) || BLOG_PATH.test(url.pathname)) {
    return "Blog or article page";
  }
  return null;
}

/** Normal form used to spot duplicates. Tracking parameters and fragments do not make a page unique. */
export function normalizeUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  url.protocol = "https:";
  return url.toString();
}

export function domainOf(raw: string): string {
  return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
}

export interface FilterResult {
  keep: string[];
  dropped: { url: string; reason: string }[];
}

/** Removes blogs, social pages and duplicates, including anything already in `seen`. */
export function filterProductUrls(urls: string[], seen: Set<string>): FilterResult {
  const keep: string[] = [];
  const dropped: FilterResult["dropped"] = [];
  for (const url of urls) {
    const reason = exclusionReason(url);
    if (reason) {
      dropped.push({ url, reason });
      continue;
    }
    const key = normalizeUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);
    keep.push(url);
  }
  return { keep, dropped };
}

export type VideoClass =
  | { kind: "link"; provider: "youtube" | "vimeo" | "tiktok" | "instagram" | "facebook"; url: string }
  | { kind: "file"; url: string }
  | null;

const YOUTUBE_HOSTS = ["youtube.com", "youtube-nocookie.com", "youtu.be"];
// Media these platforms serve from their CDNs is theirs as well, so a direct file
// URL on one of these hosts must never be downloaded.
const NEVER_DOWNLOAD_CDNS = [
  "googlevideo.com", "ytimg.com", "fbcdn.net", "cdninstagram.com", "tiktokcdn.com", "tiktokcdn-us.com",
  "tiktokv.com", "muscdn.com", "byteoversea.com",
];

/**
 * Decides how a video URL may be stored. YouTube, TikTok, Instagram and Facebook
 * are only ever links. Only direct MP4, MOV or WEBM URLs can become files.
 */
export function classifyVideo(raw: string): VideoClass {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");

  if (hostMatches(host, YOUTUBE_HOSTS)) {
    const id =
      host === "youtu.be"
        ? url.pathname.slice(1).split("/")[0]
        : url.searchParams.get("v") || url.pathname.match(/\/(?:embed|shorts|v|live)\/([\w-]+)/)?.[1];
    return id ? { kind: "link", provider: "youtube", url: `https://www.youtube.com/watch?v=${id}` } : null;
  }
  if (hostMatches(host, ["vimeo.com"])) {
    const id = url.pathname.match(/(\d{6,})/)?.[1];
    return id ? { kind: "link", provider: "vimeo", url: `https://vimeo.com/${id}` } : null;
  }
  if (hostMatches(host, ["tiktok.com"])) return { kind: "link", provider: "tiktok", url: raw };
  if (hostMatches(host, ["instagram.com"])) return { kind: "link", provider: "instagram", url: raw };
  if (hostMatches(host, ["facebook.com", "fb.com", "fb.watch"])) return { kind: "link", provider: "facebook", url: raw };
  if (hostMatches(host, NEVER_DOWNLOAD_CDNS)) return null;

  return /\.(mp4|mov|webm)$/i.test(url.pathname) ? { kind: "file", url: raw } : null;
}

export function videoExtension(contentType: string, url: string): "mp4" | "mov" | "webm" | null {
  if (contentType.includes("video/mp4")) return "mp4";
  if (contentType.includes("video/quicktime")) return "mov";
  if (contentType.includes("video/webm")) return "webm";
  const fromPath = new URL(url).pathname.match(/\.(mp4|mov|webm)$/i)?.[1]?.toLowerCase();
  // An HTML error page may sit at a .mp4 URL, so the path only counts when the
  // server's type is generic.
  if (fromPath && /^(application\/octet-stream|binary\/octet-stream|)$/.test(contentType.split(";")[0].trim())) {
    return fromPath as "mp4" | "mov" | "webm";
  }
  return null;
}

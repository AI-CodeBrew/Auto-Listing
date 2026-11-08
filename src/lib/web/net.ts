import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config, USER_AGENT } from "../config";

/**
 * Pages and the URLs they contain are untrusted. Nothing they point to may reach
 * this computer or the local network, including this app's own API.
 */
const blocked = new net.BlockList();
for (const [addr, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(addr, bits, "ipv4");
}
blocked.addAddress("::", "ipv6");
blocked.addAddress("::1", "ipv6");
blocked.addSubnet("fc00::", 7, "ipv6");
blocked.addSubnet("fe80::", 10, "ipv6");
blocked.addSubnet("ff00::", 8, "ipv6");

export function isPrivateAddress(ip: string): boolean {
  const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return blocked.check(mapped[1], "ipv4");
  const family = net.isIP(ip);
  if (family === 0) return true;
  return blocked.check(ip, family === 4 ? "ipv4" : "ipv6");
}

const hostCache = new Map<string, { ok: boolean; at: number }>();

/** True for an http(s) URL whose host resolves only to public addresses. */
export async function isPublicUrl(raw: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (config.allowPrivateNetwork()) return true;

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const cached = hostCache.get(host);
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.ok;

  let ok: boolean;
  if (net.isIP(host)) {
    ok = !isPrivateAddress(host);
  } else {
    try {
      const addrs = await dns.lookup(host, { all: true });
      ok = addrs.length > 0 && addrs.every((a) => !isPrivateAddress(a.address));
    } catch {
      ok = false;
    }
  }
  hostCache.set(host, { ok, at: Date.now() });
  return ok;
}

export class FetchError extends Error {}
export class TooLargeError extends Error {}

/** fetch() that re-checks every redirect hop against the private-network rule. */
export async function safeFetch(
  raw: string,
  init: RequestInit = {},
  timeoutMs = 30_000,
): Promise<{ response: Response; finalUrl: string }> {
  let current = raw;
  for (let hop = 0; hop <= 5; hop++) {
    if (!(await isPublicUrl(current))) throw new FetchError(`Blocked address: ${current}`);
    const response = await fetch(current, {
      ...init,
      redirect: "manual",
      headers: { "user-agent": USER_AGENT, ...(init.headers as Record<string, string>) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      await response.body?.cancel();
      current = new URL(response.headers.get("location")!, current).toString();
      continue;
    }
    return { response, finalUrl: current };
  }
  throw new FetchError(`Too many redirects: ${raw}`);
}

/**
 * Streams a URL to disk and stops as soon as the size limit is passed, even when
 * the server declares no Content-Length or declares it wrongly.
 */
export async function downloadToFile(
  raw: string,
  dest: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<{ bytes: number; contentType: string; finalUrl: string }> {
  const { response, finalUrl } = await safeFetch(raw, {}, timeoutMs);
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new FetchError(`HTTP ${response.status}`);
  }
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) {
    await response.body.cancel();
    throw new TooLargeError(`File is ${declared} bytes, over the ${maxBytes} byte limit`);
  }
  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > maxBytes) cb(new TooLargeError(`File is over the ${maxBytes} byte limit`));
      else cb(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
    counter,
    fs.createWriteStream(dest),
  );
  return {
    bytes,
    contentType: (response.headers.get("content-type") || "").toLowerCase(),
    finalUrl,
  };
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

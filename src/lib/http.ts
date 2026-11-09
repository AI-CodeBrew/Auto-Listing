import { NextResponse } from "next/server";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function hostOnly(host: string): string {
  return host.replace(/:\d+$/, "").toLowerCase();
}

/**
 * This app has no login, so a website open in your browser could otherwise send
 * requests to localhost:3000. Requests that change data must come from this app's
 * own pages, addressed to a local host name.
 */
export function rejectForeignRequest(request: Request): NextResponse | null {
  const host = request.headers.get("host") ?? "";
  const site = request.headers.get("sec-fetch-site");
  // Another website may not call this app. The page on this same address may.
  if (site && site !== "same-origin" && site !== "none") return fail("Cross-site request refused.", 403);

  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host.toLowerCase() !== host.toLowerCase()) return fail("Cross-site request refused.", 403);
    } catch {
      return fail("Cross-site request refused.", 403);
    }
  }

  if (LOCAL_HOSTS.has(hostOnly(host))) return null;
  // The deployed site is this app. A click on that page includes its own address.
  if (origin || site === "same-origin" || site === "none") return null;
  return fail("Requests must use localhost.", 403);
}

export function ok(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export function fail(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status, headers: { "cache-control": "no-store" } });
}

/** Parses pasted URLs. Returns the valid ones and any it could not accept. */
export function parseUrlList(value: unknown): { urls: string[]; invalid: string[] } {
  const lines = Array.isArray(value) ? value.map(String) : String(value ?? "").split(/[\r\n,]+/);
  const urls: string[] = [];
  const invalid: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const url = new URL(trimmed);
      if (url.protocol === "http:" || url.protocol === "https:") {
        if (!urls.includes(url.toString())) urls.push(url.toString());
      } else invalid.push(trimmed);
    } catch {
      invalid.push(trimmed);
    }
  }
  return { urls, invalid };
}

import { NextResponse, type NextRequest } from "next/server";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const isLoopback = (value: string) => /^(::1|127\.\d+\.\d+\.\d+|::ffff:127\.\d+\.\d+\.\d+|localhost)(:\d+)?$/i.test(value.trim().replace(/^\[|\]$/g, "").replace(/^for=/i, ""));

/** True when any address in a forwarding header is not this computer. */
function forwardedFromElsewhere(value: string | null): boolean {
  if (!value) return false;
  return value
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => !isLoopback(part));
}

/**
 * This app has no login and is meant for one person on their own computer. When it is also
 * reached through a public tunnel (for Google Lens), only the signed photo link may be served.
 * Everything else answers 404 to anything that did not come straight from this computer.
 *
 * A request counts as coming through a tunnel when its Host is not local, when it carries a
 * Cloudflare header, or when a forwarding header names an address that is not this computer.
 * (Next.js adds its own x-forwarded-* headers with local values, so those alone prove nothing.)
 */
export function proxy(request: NextRequest) {
  const host = (request.headers.get("host") ?? "").replace(/:\d+$/, "").toLowerCase();
  const viaTunnel =
    !LOCAL_HOSTS.has(host) ||
    request.headers.has("cf-connecting-ip") ||
    request.headers.has("cf-ray") ||
    forwardedFromElsewhere(request.headers.get("x-forwarded-for")) ||
    forwardedFromElsewhere(request.headers.get("forwarded")) ||
    forwardedFromElsewhere(request.headers.get("x-forwarded-host"));
  if (!viaTunnel) return NextResponse.next();

  if (request.method === "GET" && request.nextUrl.pathname.startsWith("/api/public-photo/")) return NextResponse.next();
  return new NextResponse("Not found", { status: 404, headers: { "cache-control": "no-store" } });
}

export const config = { matcher: "/:path*" };

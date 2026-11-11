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

/** Pages anyone may open. Everything else needs a login. */
const PUBLIC_PAGES = new Set(["/login", "/signup", "/admin/login"]);

/**
 * Two jobs:
 * 1. When the app is reached through a public tunnel (for Google Lens), only the signed photo
 *    link may be served. Everything else answers 404 to anything not from this computer.
 * 2. Pages need a login. Users go to /login, the admin pages to /admin/login. This only
 *    redirects; the backend checks the real session on every /api call.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (!process.env.VERCEL && !process.env.PLA_PUBLIC_SITE) {
    const host = (request.headers.get("host") ?? "").replace(/:\d+$/, "").toLowerCase();
    const viaTunnel =
      !LOCAL_HOSTS.has(host) ||
      request.headers.has("cf-connecting-ip") ||
      request.headers.has("cf-ray") ||
      forwardedFromElsewhere(request.headers.get("x-forwarded-for")) ||
      forwardedFromElsewhere(request.headers.get("forwarded")) ||
      forwardedFromElsewhere(request.headers.get("x-forwarded-host"));
    if (viaTunnel) {
      if (request.method === "GET" && pathname.startsWith("/api/public-photo/")) return NextResponse.next();
      return new NextResponse("Not found", { status: 404, headers: { "cache-control": "no-store" } });
    }
  }

  // The API, Next's own files and the public folder are not pages.
  if (pathname.startsWith("/api/") || pathname.startsWith("/_next/") || /\.[a-z0-9]+$/i.test(pathname)) return NextResponse.next();

  const signedIn = request.cookies.has("pla_session");
  const role = request.cookies.get("pla_role")?.value;

  if (PUBLIC_PAGES.has(pathname)) {
    // Already signed in: go where that account belongs.
    if (signedIn && role === "admin" && pathname === "/admin/login") return NextResponse.redirect(new URL("/admin", request.url));
    if (signedIn && role === "user" && pathname !== "/admin/login") return NextResponse.redirect(new URL("/", request.url));
    return NextResponse.next();
  }

  if (pathname === "/admin" || pathname.startsWith("/admin/")) {
    if (!signedIn || role !== "admin") return NextResponse.redirect(new URL("/admin/login", request.url));
    return NextResponse.next();
  }

  if (!signedIn) {
    const login = new URL("/login", request.url);
    if (pathname !== "/") login.searchParams.set("next", pathname);
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
}

export const config = { matcher: "/:path*" };

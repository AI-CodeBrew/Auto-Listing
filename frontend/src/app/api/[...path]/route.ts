/**
 * Every /api request goes to the Python (FastAPI) backend. The browser only ever talks to this
 * app, so cookies and same-origin checks work as before. Bodies are streamed both ways, so large
 * uploads and the theme push progress lines pass straight through.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BACKEND = () => (process.env.BACKEND_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");

/** Request headers the backend needs. Hop-by-hop headers are left out. */
const FORWARD = [
  "accept",
  "content-type",
  "cookie",
  "origin",
  "range",
  "referer",
  "sec-fetch-site",
  "sec-fetch-mode",
  "user-agent",
];

/** Response headers sent back to the browser. */
const RETURN = [
  "cache-control",
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "content-security-policy",
  "location",
  "x-content-type-options",
  "x-accel-buffering",
];

async function forward(request: Request): Promise<Response> {
  const incoming = new URL(request.url);
  const target = `${BACKEND()}${incoming.pathname}${incoming.search}`;
  const headers = new Headers();
  for (const name of FORWARD) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  // The backend checks Origin against the address the browser used, not its own.
  headers.set("x-pla-host", request.headers.get("host") ?? incoming.host);
  const proto = request.headers.get("x-forwarded-proto") ?? incoming.protocol.replace(":", "");
  headers.set("x-forwarded-proto", proto);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  let response: Response;
  try {
    response = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: "manual",
      cache: "no-store",
      // Lets a large upload stream instead of being read into memory first.
      ...(hasBody ? { duplex: "half" } : {}),
    } as RequestInit);
  } catch {
    return Response.json(
      { error: "The backend is not running. Start it with: cd backend, then .venv\\Scripts\\python -m uvicorn app:app --port 8000" },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }

  const out = new Headers();
  for (const name of RETURN) {
    const value = response.headers.get(name);
    if (value !== null) out.set(name, value);
  }
  for (const cookie of response.headers.getSetCookie()) out.append("set-cookie", cookie);
  return new Response(response.body, { status: response.status, headers: out });
}

export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
export const HEAD = forward;

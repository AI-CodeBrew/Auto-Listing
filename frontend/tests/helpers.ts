import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, type APIRequestContext } from "@playwright/test";
import { MOCK_URL, type MockState } from "./mock/server";

/** The frontend folder. */
export const ROOT = path.resolve(__dirname, "..");
/** The project folder, which holds frontend/ (with theme-templates/) and backend/. */
export const PROJECT = path.resolve(ROOT, "..");
export const BACKEND_DIR = path.join(PROJECT, "backend");
export const PYTHON = path.join(BACKEND_DIR, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
export const TEST_DIR = path.join(ROOT, ".test-data");
/** Test-only admin login and session secret. Never real values. */
export const ADMIN_EMAIL = "admin@test.local";
export const ADMIN_PASSWORD = "test-admin-password";
export const STORAGE_STATE = path.join(TEST_DIR, "admin-state.json");
/** The backend of an app on port N listens on N + 2000. */
export const backendPort = (port: number) => port + 2000;
export const APP_PORT = 3100;
export const APP_URL = `http://localhost:${APP_PORT}`;
export const VIDEO_FILE = path.join(TEST_DIR, "sample.mp4");
export const IMAGE_FILE = path.join(TEST_DIR, "upload.jpg");

/** Env for a test app instance. Each instance gets its own database and storage. */
export function appEnv(name: string, overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: "production",
    NEXT_DIST_DIR: ".next-test",
    APP_DATA_DIR: path.join(TEST_DIR, name, "data"),
    APP_STORAGE_DIR: path.join(TEST_DIR, name, "storage"),
    AI_PROVIDER: "claude",
    OPENAI_API_KEY: "",
    PUBLIC_BASE_URL: "",
    SERPAPI_KEY: "",
    SERPAPI_API_KEY: "",
    SERPAPI_API_KEY_2: "",
    AI_API_KEY: "mock-key",
    AI_MODEL: "claude-sonnet-5-5",
    AI_BASE_URL_OVERRIDE: MOCK_URL,
    SHOPIFY_STORE_DOMAIN: "mock-store.myshopify.com",
    SHOPIFY_CLIENT_ID: "mock-client",
    SHOPIFY_CLIENT_SECRET: "mock-secret",
    // Empty, so an Admin token in your own .env never reaches the tests.
    SHOPIFY_ADMIN_TOKEN: "",
    SHOPIFY_API_VERSION: "2026-10",
    SHOPIFY_BASE_URL_OVERRIDE: MOCK_URL,
    BING_BASE_URL_OVERRIDE: MOCK_URL,
    ALLOW_PRIVATE_NETWORK: "1",
    REQUEST_DELAY_MS: "10",
    DATABASE_URL: "",
    SUPABASE_URL: "",
    SUPABASE_ANON_KEY: "",
    SUPABASE_SERVICE_ROLE_KEY: "",
    YOUTUBE_API_KEY: "",
    META_ACCESS_TOKEN: "",
    META_APP_ID: "",
    META_APP_SECRET: "",
    FASTMOSS_API_KEY: "",
    // The backend reads only these values, never your own .env.
    PLA_SKIP_ENV_FILES: "1",
    // Files stay on this computer during tests; real Bunny keys never reach them.
    BUNNY_STORAGE_KEY: "",
    BUNNY_STORAGE_ZONE: "",
    BUNNY_STORAGE_HOST: "",
    BUNNY_CDN_URL: "",
    APP_ROOT: PROJECT,
    AUTH_SECRET: "test-only-session-secret",
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
    ...overrides,
  };
}

/**
 * Starts the FastAPI backend and the Next.js frontend for one test app. The returned process is the
 * frontend; killApp stops both, like a crash or a closed terminal.
 */
export async function startApp(name: string, port: number, overrides: Record<string, string> = {}): Promise<ChildProcess> {
  const env = appEnv(name, { BACKEND_URL: `http://127.0.0.1:${backendPort(port)}`, ...overrides });
  const log = fs.createWriteStream(path.join(TEST_DIR, `${name}.log`), { flags: "a" });
  const backend = spawn(PYTHON, ["-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", String(backendPort(port)), "--log-level", "warning"], {
    cwd: BACKEND_DIR,
    env: { ...env, PYTHONUNBUFFERED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  backend.stdout?.pipe(log);
  backend.stderr?.pipe(log);
  const child = spawn(process.execPath, [path.join(ROOT, "node_modules/next/dist/bin/next"), "start", "--hostname", "localhost", "--port", String(port)], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  (child as ChildProcess & { backend?: ChildProcess }).backend = backend;
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const response = await fetch(`http://localhost:${port}/api/status`);
      if (response.ok && (await response.json()).ok) return child;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`App ${name} did not start. See ${name}.log`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/** Kills abruptly, like a crash or a closed terminal. */
export function killApp(child: ChildProcess): void {
  const backend = (child as ChildProcess & { backend?: ChildProcess }).backend;
  for (const pid of [child.pid, backend?.pid]) {
    if (!pid) continue;
    try {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
    } catch {
      // Already gone.
    }
  }
}

/** Logs in as the test admin and saves the session, so every test's request and page are signed in. */
export async function saveAdminSession(port = APP_PORT): Promise<void> {
  const response = await fetch(`http://localhost:${port}/api/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: `http://localhost:${port}` },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!response.ok) throw new Error(`Admin login failed: ${response.status} ${await response.text()}`);
  const cookies = response.headers.getSetCookie().map((line) => {
    const [pair] = line.split(";");
    const index = pair.indexOf("=");
    return {
      name: pair.slice(0, index),
      value: pair.slice(index + 1).replace(/^"|"$/g, ""),
      domain: "localhost",
      path: "/",
      expires: Math.floor(Date.now() / 1000) + 86_400,
      httpOnly: !pair.startsWith("pla_role"),
      secure: false,
      sameSite: "Lax" as const,
    };
  });
  fs.writeFileSync(STORAGE_STATE, JSON.stringify({ cookies, origins: [] }, null, 2));
}

export async function mockState(): Promise<MockState> {
  return (await (await fetch(`${MOCK_URL}/__state`)).json()) as MockState;
}
export async function mockReset(): Promise<void> {
  await fetch(`${MOCK_URL}/__reset`, { method: "POST" });
}
export async function mockSet(values: Partial<MockState>): Promise<void> {
  await fetch(`${MOCK_URL}/__set`, { method: "POST", body: JSON.stringify(values) });
}

interface NewProduct {
  name?: string;
  details?: string;
  urls?: string[];
  file?: string;
}

export async function createProduct(request: APIRequestContext, input: NewProduct, base = APP_URL): Promise<string> {
  const multipart: Record<string, any> = { name: input.name ?? "", details: input.details ?? "", urls: (input.urls ?? []).join("\n") };
  if (input.file) {
    multipart.file = {
      name: path.basename(input.file),
      mimeType: input.file.endsWith(".mp4") ? "video/mp4" : "image/jpeg",
      buffer: fs.readFileSync(input.file),
    };
  }
  const response = await request.post(`${base}/api/products`, { multipart });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()).product.id;
}

export async function detail(request: APIRequestContext, id: string, base = APP_URL) {
  return (await (await request.get(`${base}/api/products/${id}`)).json()) as any;
}

export async function waitForStage(request: APIRequestContext, id: string, stage: string, base = APP_URL, timeoutMs = 90_000) {
  let last: any;
  await expect
    .poll(
      async () => {
        last = await detail(request, id, base);
        return last.product.stage;
      },
      { timeout: timeoutMs, intervals: [250], message: "waiting for stage" },
    )
    .toBe(stage);
  return last;
}

/** Runs research, then approves with the given selection (default: whatever was preselected). */
export async function toListing(request: APIRequestContext, input: NewProduct, base = APP_URL): Promise<any> {
  const id = await createProduct(request, input, base);
  const reviewed = await waitForStage(request, id, "review", base);
  const response = await request.post(`${base}/api/products/${id}/approve`, {
    data: {
      name: reviewed.product.name,
      description: reviewed.product.description,
      imageIds: reviewed.images.filter((i: any) => i.selected).map((i: any) => i.id),
      videoIds: reviewed.videos.filter((v: any) => v.passed && v.provider !== "tiktok").map((v: any) => v.id),
    },
  });
  expect(response.status(), await response.text()).toBe(200);
  return detail(request, id, base);
}

export async function waitForShopify(request: APIRequestContext, id: string, status: string, base = APP_URL) {
  let last: any;
  await expect
    .poll(
      async () => {
        last = await detail(request, id, base);
        return last.product.shopify_status;
      },
      { timeout: 30_000, intervals: [100], message: "waiting for Shopify status" },
    )
    .toBe(status);
  return last;
}

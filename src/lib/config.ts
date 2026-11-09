import path from "node:path";

/**
 * All environment access lives here. Values are read at call time so tests can
 * point the app at local mock servers.
 *
 * The *_OVERRIDE / ALLOW_PRIVATE_NETWORK variables are for the automated tests
 * only and are deliberately not listed in .env.example.
 */
export const config = {
  // Runtime folders. The comments stop the bundler from tracing the whole project.
  dataDir: () => path.resolve(/*turbopackIgnore: true*/ process.env.APP_DATA_DIR || "./data"),
  /** Postgres connection for the Supabase copy. Empty keeps data only on this computer. */
  databaseUrl: () => process.env.DATABASE_URL?.trim() || "",
  storageDir: () => path.resolve(/*turbopackIgnore: true*/ process.env.APP_STORAGE_DIR || "./storage"),

  /** "openai" or "claude". Without AI_PROVIDER: OpenAI when only OPENAI_API_KEY is set, else Claude. */
  aiProvider: (): "openai" | "claude" => {
    const chosen = process.env.AI_PROVIDER?.trim().toLowerCase();
    if (chosen === "openai" || chosen === "claude") return chosen;
    return process.env.OPENAI_API_KEY?.trim() && !process.env.AI_API_KEY?.trim() ? "openai" : "claude";
  },
  openaiApiKey: () => process.env.OPENAI_API_KEY?.trim() || "",
  openaiModel: () => process.env.OPENAI_MODEL?.trim() || "gpt-6-luna",
  /** YouTube Data API key. Never sent to the browser. */
  youtubeApiKey: () => process.env.YOUTUBE_API_KEY?.trim() || "",
  /** Meta Ad Library. The token, app id, and secret stay on the server. */
  metaAccessToken: () => process.env.META_ACCESS_TOKEN?.trim() || "",
  metaAppId: () => process.env.META_APP_ID?.trim() || "",
  metaAppSecret: () => process.env.META_APP_SECRET?.trim() || "",
  openaiBaseUrl: () => (process.env.OPENAI_BASE_URL_OVERRIDE?.trim() || "https://api.openai.com").replace(/\/+$/, ""),

  aiApiKey: () => process.env.AI_API_KEY?.trim() || "",
  aiModel: () => process.env.AI_MODEL?.trim() || "claude-sonnet-5-5",
  aiBaseUrl: () => process.env.AI_BASE_URL_OVERRIDE?.trim() || undefined,

  shopifyApiVersion: () => process.env.SHOPIFY_API_VERSION?.trim() || "2026-10",
  /** Replaces https://<store domain> so tests can talk to the mock Shopify. */
  shopifyBaseUrlOverride: () => process.env.SHOPIFY_BASE_URL_OVERRIDE?.trim() || "",

  /** Key 1 is SERPAPI_API_KEY (or SERPAPI_KEY). Key 2 is 2_SERPAPI_API_KEY. Values stay in .env. */
  serpApiKeys: (): [string, string] => [
    process.env.SERPAPI_KEY?.trim() || process.env.SERPAPI_API_KEY?.trim() || "",
    (process.env["2_SERPAPI_API_KEY"] ?? "").trim(),
  ],
  /** True when either SerpAPI key is present. The key string is not returned to the browser. */
  serpApiKey: () => {
    const [first, second] = [
      process.env.SERPAPI_KEY?.trim() || process.env.SERPAPI_API_KEY?.trim() || "",
      (process.env["2_SERPAPI_API_KEY"] ?? "").trim(),
    ];
    return first || second;
  },
  serpApiBaseUrl: () => (process.env.SERPAPI_BASE_URL_OVERRIDE?.trim() || "https://serpapi.com").replace(/\/+$/, ""),
  /** FastMoss MCP endpoint. The API key itself is saved in the app, or in FASTMOSS_API_KEY. */
  fastmossMcpUrl: () => (process.env.FASTMOSS_MCP_URL_OVERRIDE?.trim() || "https://mcp.fastmoss.com/mcp").replace(/\/+$/, ""),
  /**
   * The public address of this app, from a tunnel such as Cloudflare or ngrok. Google Lens
   * can only fetch a photo from a public address. Only the Lens photo route is served there.
   */
  publicBaseUrl: () => {
    const raw = process.env.PUBLIC_BASE_URL?.trim();
    if (!raw) return "";
    try {
      const url = new URL(raw);
      return url.protocol === "https:" || url.protocol === "http:" ? url.origin : "";
    } catch {
      return "";
    }
  },
  bingBaseUrl: () => process.env.BING_BASE_URL_OVERRIDE?.trim() || "https://www.bing.com",
  requestDelayMs: () => Number(process.env.REQUEST_DELAY_MS ?? 1500),
  allowPrivateNetwork: () => process.env.ALLOW_PRIVATE_NETWORK === "1",
};

export const LIMITS = {
  pageTimeoutMs: 30_000,
  pagesPerTry: 8,
  /** Searches after the first when fewer than the target number of images pass. */
  extraSearchTries: 3,
  targetImages: 5,
  maxPreselectedImages: 10,
  imageMaxBytes: 20 * 1024 * 1024,
  /** Photos attached to one new listing. The first is the photo used for search. */
  uploadImages: 20,
  videoMaxBytes: 1024 * 1024 * 1024,
  imageMinSide: 800,
  /** Below this we treat a file as an icon or thumbnail and skip it silently. */
  iconMaxSide: 200,
  imagesPerPage: 12,
  maxVideoDownloads: 5,
  sourceTextChars: 12_000,
  jobMaxAttempts: 3,
};

/** How much AI work one product gets. */
export function aiLimits() {
  return { maxImagesToAiCheck: 30, stopCheckingAfterPasses: 15, framesPerVideo: 4, visionMaxSide: 1280, maxReferenceImages: 3 };
}

export const USER_AGENT_TOKEN = "ProductListingAssistant";
export const USER_AGENT = `${USER_AGENT_TOKEN}/1.0`;

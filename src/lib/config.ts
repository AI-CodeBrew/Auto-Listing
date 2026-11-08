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
  storageDir: () => path.resolve(/*turbopackIgnore: true*/ process.env.APP_STORAGE_DIR || "./storage"),

  /** "openai" or "claude". Without AI_PROVIDER: OpenAI when only OPENAI_API_KEY is set, else Claude. */
  aiProvider: (): "openai" | "claude" => {
    const chosen = process.env.AI_PROVIDER?.trim().toLowerCase();
    if (chosen === "openai" || chosen === "claude") return chosen;
    return process.env.OPENAI_API_KEY?.trim() && !process.env.AI_API_KEY?.trim() ? "openai" : "claude";
  },
  openaiApiKey: () => process.env.OPENAI_API_KEY?.trim() || "",
  openaiModel: () => process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini",
  openaiBaseUrl: () => (process.env.OPENAI_BASE_URL_OVERRIDE?.trim() || "https://api.openai.com").replace(/\/+$/, ""),

  aiApiKey: () => process.env.AI_API_KEY?.trim() || "",
  aiModel: () => process.env.AI_MODEL?.trim() || "claude-sonnet-5-5",
  aiBaseUrl: () => process.env.AI_BASE_URL_OVERRIDE?.trim() || undefined,

  shopifyApiVersion: () => process.env.SHOPIFY_API_VERSION?.trim() || "2026-10",
  /** Replaces https://<store domain> so tests can talk to the mock Shopify. */
  shopifyBaseUrlOverride: () => process.env.SHOPIFY_BASE_URL_OVERRIDE?.trim() || "",

  /** SERPAPI_API_KEY is accepted as another name for SERPAPI_KEY. */
  serpApiKey: () => process.env.SERPAPI_KEY?.trim() || process.env.SERPAPI_API_KEY?.trim() || "",
  serpApiBaseUrl: () => (process.env.SERPAPI_BASE_URL_OVERRIDE?.trim() || "https://serpapi.com").replace(/\/+$/, ""),
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

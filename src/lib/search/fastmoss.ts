import { config } from "../config";
import { noteRunningUsage } from "../repo";
import { fastmossApiKey } from "../settings";

/** One video returned by FastMoss video_search. */
export interface FastMossVideo {
  url: string;
  title: string;
  creator: string;
  /** FastMoss page for the video, when that is different from the video URL. */
  pageUrl: string;
}

interface JsonSchema {
  properties?: Record<string, { type?: string; enum?: unknown[] }>;
  required?: string[];
}

const TEXT_FIELDS = ["keywords", "keyword", "query", "q", "word", "words", "search", "title", "video_title"];
const REGION_FIELDS = ["region", "country", "market", "region_code"];
const LIMIT_FIELDS = ["page_size", "limit", "size", "pageSize"];
const URL_FIELDS = ["tiktok_url", "video_url", "share_url", "url", "fastmoss_url", "play_url", "video_play_url"];
const TITLE_FIELDS = ["title", "video_desc", "desc", "description", "video_title"];
const CREATOR_FIELDS = ["nickname", "author_name", "creator_name", "unique_id", "author"];

/**
 * Builds the arguments for video_search from the tool's schema when FastMoss has published one.
 * Without a schema, keywords and the US region are sent.
 */
export function videoSearchArguments(schema: JsonSchema | undefined, query: string): Record<string, unknown> {
  const properties = schema?.properties ?? {};
  const names = Object.keys(properties);
  const args: Record<string, unknown> = {};
  const textName = TEXT_FIELDS.find((name) => names.includes(name));
  const regionName = REGION_FIELDS.find((name) => names.includes(name));

  if (textName) args[textName] = query;
  else if (!names.length) args.keywords = query;
  else {
    const required = schema?.required ?? [];
    const fallback = [...required, ...names].find((name) => name !== regionName && (!properties[name]?.type || properties[name]?.type === "string"));
    if (fallback) args[fallback] = query;
  }

  if (regionName) {
    const options = (properties[regionName]?.enum ?? []).map(String);
    const us = options.find((value) => /^(us|usa)$/i.test(value) || /united states/i.test(value));
    args[regionName] = us ?? (options[0] || "US");
  } else if (!names.length) {
    args.region = "US";
  }

  const limitName = LIMIT_FIELDS.find((name) => names.includes(name));
  if (limitName) args[limitName] = 8;
  return args;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function httpUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function looksLikeImage(url: string): boolean {
  try {
    return /\.(jpe?g|png|gif|webp|avif|svg)$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Pulls video links out of a FastMoss tool result, whatever shape the JSON happens to use. */
export function videosFromPayload(payload: unknown, limit = 8): FastMossVideo[] {
  const found: FastMossVideo[] = [];
  const seen = new Set<string>();

  const visit = (value: unknown) => {
    if (found.length >= limit) return;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          visit(JSON.parse(trimmed));
        } catch {
          // Plain text, not a nested payload.
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = asRecord(value);
    if (!record) return;
    const candidates = URL_FIELDS.map((key) => (typeof record[key] === "string" ? httpUrl(record[key] as string) : "")).filter((item) => item && !looksLikeImage(item));
    const videoId = firstString(record, ["video_id", "aweme_id", "item_id", "videoId"]);
    const user = firstString(record, ["unique_id", "author_unique_id"]).replace(/^@/, "");
    const playable = candidates.find((item) => /tiktok\.com|youtube\.com|youtu\.be|vimeo\.com/i.test(item));
    const fastmossPage = candidates.find((item) => /fastmoss\.com/i.test(item)) ?? "";
    const built = videoId && user ? `https://www.tiktok.com/@${encodeURIComponent(user)}/video/${encodeURIComponent(videoId)}` : "";
    const url = playable || built || fastmossPage || candidates.find((item) => /\/video\//i.test(item)) || "";
    if (url && !seen.has(url)) {
      seen.add(url);
      found.push({
        url,
        title: firstString(record, TITLE_FIELDS),
        creator: firstString(record, CREATOR_FIELDS),
        pageUrl: fastmossPage && fastmossPage !== url ? fastmossPage : "",
      });
    }
    for (const nested of Object.values(record)) visit(nested);
  };

  visit(payload);
  return found.slice(0, limit);
}

interface RpcResult {
  sessionId: string;
  body: { result?: unknown; error?: { message?: string } };
}

function parseRpc(text: string): RpcResult["body"] {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("FastMoss returned an empty response.");
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as RpcResult["body"];
  const data = trimmed
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]");
  const last = data.at(-1);
  if (!last) throw new Error("FastMoss returned a response that was not JSON.");
  return JSON.parse(last) as RpcResult["body"];
}

async function rpc(method: string, params: unknown, sessionId = ""): Promise<RpcResult> {
  const key = fastmossApiKey();
  if (!key) throw new Error("No FastMoss API key is saved.");
  let response: Response;
  try {
    response = await fetch(config.fastmossMcpUrl(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-api-key": key,
        "mcp-protocol-version": "2025-03-26",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: method === "notifications/initialized" ? undefined : 1, method, params }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new Error(`Could not reach FastMoss. Check your internet connection. ${error instanceof Error ? error.message : ""}`.trim());
  }
  const text = await response.text();
  if (response.status === 401 || response.status === 403) throw new Error("FastMoss rejected FASTMOSS_API_KEY. Check the key in .env and restart the app.");
  let body: RpcResult["body"];
  try {
    body = parseRpc(text);
  } catch (error) {
    if (!response.ok) throw new Error(`FastMoss returned HTTP ${response.status}.`);
    throw error instanceof Error ? error : new Error("FastMoss returned a response that was not JSON.");
  }
  if (body.error?.message) throw new Error(`FastMoss error: ${body.error.message}`);
  if (!response.ok) throw new Error(`FastMoss returned HTTP ${response.status}.`);
  return { sessionId: response.headers.get("mcp-session-id") ?? sessionId, body };
}

const schemaHolder = globalThis as unknown as { __plaFastmossVideoSchema?: JsonSchema | null };

async function videoSearchSchema(sessionId: string): Promise<JsonSchema | undefined> {
  if (schemaHolder.__plaFastmossVideoSchema !== undefined) return schemaHolder.__plaFastmossVideoSchema ?? undefined;
  try {
    const listed = await rpc("tools/list", {}, sessionId);
    const tools = (listed.body.result as { tools?: { name?: string; inputSchema?: JsonSchema; input_schema?: JsonSchema }[] } | undefined)?.tools ?? [];
    const tool = tools.find((item) => item.name === "video_search");
    schemaHolder.__plaFastmossVideoSchema = tool?.inputSchema ?? tool?.input_schema ?? null;
  } catch {
    return undefined;
  }
  return schemaHolder.__plaFastmossVideoSchema ?? undefined;
}

async function openSession(): Promise<string> {
  const started = await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "product-listing-assistant", version: "1.0.0" },
  });
  await rpc("notifications/initialized", {}, started.sessionId).catch(() => undefined);
  return started.sessionId;
}

/** Confirms the saved key is accepted. Does not search, so it does not spend a video-search credit. */
export async function testFastMoss(): Promise<{ tools: number }> {
  const sessionId = await openSession();
  const listed = await rpc("tools/list", {}, sessionId);
  const tools = (listed.body.result as { tools?: unknown[] } | undefined)?.tools ?? [];
  return { tools: tools.length };
}

/** Searches TikTok videos for this product through FastMoss. One call is one credit. */
export async function searchVideos(query: string): Promise<FastMossVideo[]> {
  const sessionId = await openSession();
  const schema = await videoSearchSchema(sessionId);
  const called = await rpc("tools/call", { name: "video_search", arguments: videoSearchArguments(schema, query) }, sessionId);
  noteRunningUsage({ fastmoss: 1 });
  const result = called.body.result as { isError?: boolean; content?: { text?: string }[] } | undefined;
  if (result?.isError) {
    const message = result.content?.map((item) => item.text).filter(Boolean).join(" ") || "FastMoss could not search videos.";
    throw new Error(message.slice(0, 300));
  }
  const texts = result?.content?.map((item) => item.text).filter((item): item is string => Boolean(item)) ?? [];
  const hits = videosFromPayload(texts.length ? texts : called.body.result);
  return hits;
}

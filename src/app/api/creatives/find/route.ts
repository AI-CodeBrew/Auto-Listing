import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import busboy from "busboy";
import { AiError } from "@/lib/ai";
import { LIMITS } from "@/lib/config";
import { CreativeError, findCreatives, type CreativeRequest } from "@/lib/creatives";
import { fail, ok, rejectForeignRequest } from "@/lib/http";
import { removeQuietly, tempPath } from "@/lib/storage";
import { whenReady } from "@/lib/supabase";

export async function POST(request: Request) {
  await whenReady();
  const refused = rejectForeignRequest(request);
  if (refused) return refused;

  const temps: string[] = [];
  try {
    const query = await readQuery(request, temps);
    return ok(await findCreatives(query));
  } catch (error) {
    if (error instanceof CreativeError) return fail(error.message, error.status);
    if (error instanceof AiError) return fail(error.message, 502);
    console.error("[creatives]", error instanceof Error ? error.message : "search failed");
    return fail("The search failed. Try again.", 500);
  } finally {
    for (const file of temps) removeQuietly(file);
  }
}

async function readQuery(request: Request, temps: string[]): Promise<CreativeRequest> {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("multipart/form-data")) return readUpload(request, temps);
  let body: {
    imageUrl?: unknown;
    title?: unknown;
    brand?: unknown;
    model?: unknown;
    color?: unknown;
    packagingText?: unknown;
    keywords?: unknown;
    shortsOnly?: unknown;
    days?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    throw new CreativeError("The request could not be read.");
  }
  return {
    imageUrl: typeof body.imageUrl === "string" ? body.imageUrl : undefined,
    title: text(body.title),
    brand: text(body.brand),
    model: text(body.model),
    color: text(body.color),
    packagingText: text(body.packagingText),
    keywords: Array.isArray(body.keywords) ? body.keywords.filter((word): word is string => typeof word === "string") : undefined,
    shortsOnly: flag(body.shortsOnly, true),
    days: daysOf(body.days),
  };
}

function readUpload(request: Request, temps: string[]): Promise<CreativeRequest> {
  return new Promise((resolve, reject) => {
    const contentType = request.headers.get("content-type") ?? "";
    if (!request.body) {
      reject(new CreativeError("Expected a form upload."));
      return;
    }
    const fields: Record<string, string> = {};
    let filePath: string | null = null;
    let error: string | null = null;
    const writes: Promise<unknown>[] = [];
    const parser = busboy({
      headers: { "content-type": contentType },
      limits: { files: 1, fileSize: LIMITS.imageMaxBytes, fieldSize: 8000 },
    });
    parser.on("field", (name, value) => {
      fields[name] = value;
    });
    parser.on("filesLimit", () => {
      error = "Upload one product image.";
    });
    parser.on("file", (_name, stream, info) => {
      if (!info.filename) {
        stream.resume();
        return;
      }
      if (!(info.mimeType || "").toLowerCase().startsWith("image/")) {
        error = "That file is not a readable image.";
        stream.resume();
        return;
      }
      if (filePath) {
        error = "Upload one product image.";
        stream.resume();
        return;
      }
      const tmp = tempPath("creatives", "images");
      temps.push(tmp);
      filePath = tmp;
      stream.on("limit", () => {
        error = "Images can be at most 20 MB.";
      });
      writes.push(pipeline(stream, fs.createWriteStream(tmp)));
    });
    parser.on("error", reject);
    parser.on("close", () => {
      Promise.all(writes).then(() => {
        if (error) {
          reject(new CreativeError(error));
          return;
        }
        resolve({
          image: filePath ? fs.readFileSync(filePath) : undefined,
          imageUrl: fields.imageUrl,
          title: fields.title,
          brand: fields.brand,
          model: fields.model,
          color: fields.color,
          packagingText: fields.packagingText,
          keywords: keywordsFrom(fields.keywords),
          shortsOnly: flag(fields.shortsOnly, true),
          days: daysOf(fields.days),
        });
      }, reject);
    });
    Readable.fromWeb(request.body as import("node:stream/web").ReadableStream).on("error", reject).pipe(parser);
  });
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function keywordsFrom(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((word): word is string => typeof word === "string");
  } catch {
    return value.split("\n");
  }
  return undefined;
}

function flag(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "0" || value === "false") return false;
    if (value === "1" || value === "true") return true;
  }
  return fallback;
}

function daysOf(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 180;
}

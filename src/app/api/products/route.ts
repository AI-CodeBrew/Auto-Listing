import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import busboy from "busboy";
import sharp from "sharp";
import { LIMITS } from "@/lib/config";
import { fail, ok, parseUrlList, rejectForeignRequest } from "@/lib/http";
import * as repo from "@/lib/repo";
import { commitFile, removeQuietly, tempPath } from "@/lib/storage";
import type { ProductStage } from "@/lib/types";

const VIDEO_TYPES: Record<string, string> = { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" };
const VIDEO_EXT = /\.(mp4|mov|webm)$/i;
const ALL_STAGES: ProductStage[] = ["researching", "blocked", "failed", "review", "listing", "rejected"];

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("stages");
  const stages = raw ? (raw.split(",").filter((s) => ALL_STAGES.includes(s as ProductStage)) as ProductStage[]) : ALL_STAGES;
  if (!stages.length) return fail("Unknown stage");
  const products = repo.listProducts(stages).map((product) => ({
    ...product,
    source_text: undefined,
    image_count: repo.listImages(product.id).filter((image) => image.selected).length,
  }));
  return ok({ products, counts: repo.countByStage() });
}

interface Parsed {
  fields: Record<string, string>;
  tmp: string | null;
  kind: "image" | "video" | null;
  videoExt: string | null;
  error: string | null;
}

/** Streams the upload to disk, so a large video does not have to fit in memory. */
function parseUpload(request: Request, productId: string): Promise<Parsed> {
  return new Promise((resolve, reject) => {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data") || !request.body) {
      reject(new Error("Expected a form upload"));
      return;
    }
    const result: Parsed = { fields: {}, tmp: null, kind: null, videoExt: null, error: null };
    const writes: Promise<unknown>[] = [];
    const parser = busboy({ headers: { "content-type": contentType }, limits: { files: 1, fileSize: LIMITS.videoMaxBytes, fieldSize: 1024 * 1024 } });

    parser.on("field", (name, value) => {
      result.fields[name] = value;
    });
    parser.on("file", (_name, stream, info) => {
      const mime = (info.mimeType || "").toLowerCase();
      const isVideo = Boolean(VIDEO_TYPES[mime]) || VIDEO_EXT.test(info.filename || "");
      const isImage = mime.startsWith("image/");
      if (!info.filename) {
        stream.resume();
        return;
      }
      if (!isVideo && !isImage) {
        result.error = "Upload an image, or an MP4, MOV or WEBM video.";
        stream.resume();
        return;
      }
      result.kind = isVideo ? "video" : "image";
      result.videoExt = isVideo ? (VIDEO_TYPES[mime] ?? (info.filename.match(VIDEO_EXT)?.[1] ?? "mp4").toLowerCase()) : null;
      const tmp = tempPath(productId, isVideo ? "videos" : "images");
      result.tmp = tmp;
      stream.on("limit", () => {
        result.error = "That file is larger than the 1 GB limit.";
      });
      writes.push(pipeline(stream, fs.createWriteStream(tmp)));
    });
    parser.on("error", reject);
    parser.on("close", () => {
      Promise.all(writes).then(() => resolve(result), reject);
    });
    Readable.fromWeb(request.body as import("node:stream/web").ReadableStream).on("error", reject).pipe(parser);
  });
}

export async function POST(request: Request) {
  const refused = rejectForeignRequest(request);
  if (refused) return refused;

  const id = randomUUID();
  const cleanup = () => fs.rmSync(path.dirname(path.dirname(tempPath(id, "images"))), { recursive: true, force: true });

  let parsed: Parsed;
  try {
    parsed = await parseUpload(request, id);
  } catch (error) {
    cleanup();
    return fail(error instanceof Error ? error.message : "The upload failed.");
  }
  if (parsed.error) {
    cleanup();
    return fail(parsed.error);
  }

  const name = (parsed.fields.name ?? "").trim().slice(0, 300) || null;
  const details = (parsed.fields.details ?? "").trim() || null;
  if (details && (details.length < 8 || details.length > 4000)) {
    cleanup();
    return fail("Product details must be between 8 and 4000 characters, or left empty.");
  }
  const { urls, invalid } = parseUrlList(parsed.fields.urls);
  if (invalid.length) {
    cleanup();
    return fail(`These are not valid web addresses: ${invalid.join(", ")}`);
  }
  if (!parsed.tmp && !name) {
    cleanup();
    return fail("Enter a product name, or upload an image or video.");
  }

  let image: string | null = null;
  let video: string | null = null;
  try {
    if (parsed.tmp && parsed.kind === "video") {
      video = commitFile(id, "videos", parsed.tmp, parsed.videoExt ?? "mp4");
    } else if (parsed.tmp) {
      if (fs.statSync(parsed.tmp).size > LIMITS.imageMaxBytes) {
        cleanup();
        return fail("Images can be at most 20 MB.");
      }
      const meta = await sharp(parsed.tmp).metadata();
      const keep: Record<string, string> = { jpeg: "jpg", png: "png", webp: "webp", gif: "gif" };
      if (meta.format && keep[meta.format]) {
        image = commitFile(id, "images", parsed.tmp, keep[meta.format]);
      } else {
        const converted = tempPath(id, "images");
        await sharp(parsed.tmp).rotate().flatten({ background: "#ffffff" }).jpeg({ quality: 92 }).toFile(converted);
        removeQuietly(parsed.tmp);
        image = commitFile(id, "images", converted, "jpg");
      }
    }
  } catch {
    cleanup();
    return fail("That file could not be read as an image.");
  }

  const { product, job } = repo.createProductWithJob({ id, name, details, image, video, urls });
  return ok({ product, job }, 201);
}

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import busboy from "busboy";
import sharp from "sharp";
import { after } from "next/server";
import { LIMITS } from "@/lib/config";
import { fail, ok, parseUrlList, rejectForeignRequest } from "@/lib/http";
import * as repo from "@/lib/repo";
import { commitFile, removeQuietly, tempPath } from "@/lib/storage";
import { whenReady } from "@/lib/supabase";
import type { ProductStage } from "@/lib/types";

const VIDEO_TYPES: Record<string, string> = { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" };
const VIDEO_EXT = /\.(mp4|mov|webm)$/i;
const ALL_STAGES: ProductStage[] = ["researching", "blocked", "failed", "review", "listing", "rejected", "history"];

export const maxDuration = 300;

export async function GET(request: Request) {
  await whenReady();
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

interface SavedFile {
  tmp: string;
  kind: "image" | "video";
  videoExt: string | null;
}

interface Parsed {
  fields: Record<string, string>;
  files: SavedFile[];
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
    const result: Parsed = { fields: {}, files: [], error: null };
    const writes: Promise<unknown>[] = [];
    const parser = busboy({
      headers: { "content-type": contentType },
      limits: { files: LIMITS.uploadImages + 1, fileSize: LIMITS.videoMaxBytes, fieldSize: 1024 * 1024 },
    });

    parser.on("field", (name, value) => {
      result.fields[name] = value;
    });
    parser.on("filesLimit", () => {
      result.error = `You can add up to ${LIMITS.uploadImages} images.`;
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
      if (result.files.length >= LIMITS.uploadImages + 1) {
        result.error = `You can add up to ${LIMITS.uploadImages} images.`;
        stream.resume();
        return;
      }
      const videoExt = isVideo ? (VIDEO_TYPES[mime] ?? (info.filename.match(VIDEO_EXT)?.[1] ?? "mp4").toLowerCase()) : null;
      const tmp = tempPath(productId, isVideo ? "videos" : "images");
      result.files.push({ tmp, kind: isVideo ? "video" : "image", videoExt });
      stream.on("limit", () => {
        result.error = isVideo ? "That file is larger than the 1 GB limit." : "Images can be at most 20 MB.";
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
  await whenReady();
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
  const imageFiles = parsed.files.filter((file) => file.kind === "image");
  const videoFiles = parsed.files.filter((file) => file.kind === "video");
  if (videoFiles.length > 1) {
    cleanup();
    return fail("Only one video can be added.");
  }
  if (imageFiles.length > LIMITS.uploadImages) {
    cleanup();
    return fail(`You can add up to ${LIMITS.uploadImages} images.`);
  }
  if (!parsed.files.length && !name) {
    cleanup();
    return fail("Enter a product name, or upload an image or video.");
  }

  let image: string | null = null;
  const images: string[] = [];
  let video: string | null = null;
  try {
    for (const file of imageFiles) {
      if (fs.statSync(file.tmp).size > LIMITS.imageMaxBytes) {
        cleanup();
        return fail("Images can be at most 20 MB.");
      }
      const meta = await sharp(file.tmp).metadata();
      const keep: Record<string, string> = { jpeg: "jpg", png: "png", webp: "webp", gif: "gif" };
      let saved: string;
      if (meta.format && keep[meta.format]) {
        saved = commitFile(id, "images", file.tmp, keep[meta.format]);
      } else {
        const converted = tempPath(id, "images");
        await sharp(file.tmp).rotate().flatten({ background: "#ffffff" }).jpeg({ quality: 92 }).toFile(converted);
        removeQuietly(file.tmp);
        saved = commitFile(id, "images", converted, "jpg");
      }
      images.push(saved);
    }
    image = images[0] ?? null;
    const clip = videoFiles[0];
    if (clip) video = commitFile(id, "videos", clip.tmp, clip.videoExt ?? "mp4");
  } catch {
    cleanup();
    return fail("That file could not be read as an image.");
  }

  const searchPhotos = parsed.fields.search_photos !== "0";
  const searchVideos = parsed.fields.search_videos !== "0";
  // A full copy of every saved row was timing out, so this search never showed up on the page.
  const dbMod = await import("@/lib/db");
  const paused = dbMod.isSyncPaused();
  if (process.env["VERCEL"]) dbMod.setSyncPaused(true);
  let created: ReturnType<typeof repo.createProductWithJob>;
  try {
    created = repo.createProductWithJob({ id, name, details, image, images, video, urls, searchPhotos, searchVideos });
    if (process.env["VERCEL"]) {
      const { pushRecords } = await import("@/lib/supabase");
      await pushRecords(id);
    }
  } catch {
    cleanup();
    try {
      dbMod.db().prepare("DELETE FROM products WHERE id = ?").run(id);
    } catch {
      // The product row may not have been created.
    }
    return fail("The search could not be started. Try again.");
  } finally {
    if (process.env["VERCEL"]) dbMod.setSyncPaused(paused);
  }
  if (process.env["VERCEL"]) {
    after(async () => {
      const { drainQueue } = await import("@/lib/queue");
      await drainQueue();
    });
  }
  return ok(created, 201);
}

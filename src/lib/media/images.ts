import fs from "node:fs";
import sharp from "sharp";
import { aiLimits, LIMITS } from "../config";
import { commitFile, mediaPath, removeQuietly, tempPath } from "../storage";
import { downloadToFile, TooLargeError } from "../web/net";

// sharp's file cache keeps files open, and Windows then refuses to rename or delete them.
sharp.cache(false);

/** 64-bit DCT perceptual hash, as a hex string. Similar images have close hashes. */
export async function perceptualHash(input: string | Buffer): Promise<string> {
  const size = 32;
  const { data } = await sharp(input)
    .rotate()
    .flatten({ background: "#ffffff" })
    .resize(size, size, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const low = 8;
  const coefficient = new Array<number>(low * low);
  for (let u = 0; u < low; u++) {
    for (let v = 0; v < low; v++) {
      let sum = 0;
      for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
          sum +=
            data[y * size + x] *
            Math.cos(((2 * x + 1) * u * Math.PI) / (2 * size)) *
            Math.cos(((2 * y + 1) * v * Math.PI) / (2 * size));
        }
      }
      coefficient[u * low + v] = sum;
    }
  }
  // Skip the DC term, which only measures overall brightness.
  const median = [...coefficient.slice(1)].sort((a, b) => a - b)[Math.floor((low * low - 1) / 2)];
  let hash = 0n;
  for (let i = 0; i < low * low; i++) {
    hash = (hash << 1n) | (coefficient[i] > median ? 1n : 0n);
  }
  return hash.toString(16).padStart(16, "0");
}

export function hammingDistance(a: string, b: string): number {
  let value = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (value > 0n) {
    count += Number(value & 1n);
    value >>= 1n;
  }
  return count;
}

/** Hashes this close are treated as the same picture. */
export const DUPLICATE_DISTANCE = 6;

export type DownloadedImage =
  | { status: "ok"; fileName: string; width: number; height: number; bytes: number; phash: string; finalUrl: string }
  | { status: "too-large"; message: string }
  | { status: "skip"; reason: string };

/** sharp formats that Shopify takes as they are. Others are converted to JPEG. */
const KEEP_FORMATS: Record<string, string> = { jpeg: "jpg", png: "png", webp: "webp", gif: "gif" };

/**
 * Downloads an image, trying the likely full-size URL first. The file's real format
 * and size come from decoding it, not from what the server claims.
 */
export async function downloadImage(productId: string, urls: string[]): Promise<DownloadedImage> {
  let lastError = "no usable URL";
  for (const url of urls) {
    const tmp = tempPath(productId, "images");
    try {
      const { bytes, finalUrl } = await downloadToFile(url, tmp, LIMITS.imageMaxBytes, 60_000);
      const meta = await sharp(tmp).metadata();
      const width = meta.width ?? 0;
      const height = meta.height ?? 0;
      if (!meta.format || meta.format === ("svg" as string)) {
        removeQuietly(tmp);
        lastError = "not a raster image";
        continue;
      }
      if (Math.max(width, height) < LIMITS.iconMaxSide) {
        removeQuietly(tmp);
        lastError = "icon-sized image";
        continue;
      }
      const phash = await perceptualHash(tmp);
      let ext = KEEP_FORMATS[meta.format];
      let finalBytes = bytes;
      if (!ext) {
        const converted = tempPath(productId, "images");
        const info = await sharp(tmp).rotate().flatten({ background: "#ffffff" }).jpeg({ quality: 92 }).toFile(converted);
        removeQuietly(tmp);
        fs.renameSync(converted, tmp);
        ext = "jpg";
        finalBytes = info.size;
      }
      return { status: "ok", fileName: commitFile(productId, "images", tmp, ext), width, height, bytes: finalBytes, phash, finalUrl };
    } catch (error) {
      removeQuietly(tmp);
      if (error instanceof TooLargeError) return { status: "too-large", message: "Image is larger than the 20 MB limit" };
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { status: "skip", reason: lastError };
}

/** Reads the size and hash of a stored image. Throws if it cannot be decoded. */
export async function inspectImageFile(productId: string, fileName: string) {
  const file = mediaPath(productId, "images", fileName);
  const meta = await sharp(file).metadata();
  return {
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    bytes: fs.statSync(file).size,
    phash: await perceptualHash(file),
  };
}

/**
 * Shrinks an image for a Vision request. Large originals would exceed the API's
 * size limits and cost more without improving the check.
 */
export async function forVision(input: string | Buffer): Promise<Buffer> {
  const side = aiLimits().visionMaxSide;
  return sharp(input)
    .rotate()
    .flatten({ background: "#ffffff" })
    .resize(side, side, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
}

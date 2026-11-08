import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config";

/**
 * File storage. Everything that touches ./storage goes through this module, so
 * it can be swapped for another backend later.
 *
 * Layout: storage/<productId>/images/<file> and storage/<productId>/videos/<file>
 */
export type MediaKind = "images" | "videos";

const SAFE_ID = /^[a-zA-Z0-9-]+$/;
const SAFE_FILE = /^[a-zA-Z0-9._-]+$/;

export function isSafeKind(kind: string): kind is MediaKind {
  return kind === "images" || kind === "videos";
}

export function mediaPath(productId: string, kind: MediaKind, fileName: string): string {
  if (!SAFE_ID.test(productId) || !SAFE_FILE.test(fileName) || fileName.startsWith(".")) {
    throw new Error("Invalid storage path");
  }
  return path.join(config.storageDir(), productId, kind, fileName);
}

export function ensureDirs(productId: string): void {
  for (const kind of ["images", "videos"] as const) {
    fs.mkdirSync(path.dirname(mediaPath(productId, kind, "x")), { recursive: true });
  }
}

/** A path in the product's folder for a file that is still being written. */
export function tempPath(productId: string, kind: MediaKind): string {
  ensureDirs(productId);
  return mediaPath(productId, kind, `tmp-${randomUUID()}.part`);
}

/** Moves a finished temp file to its final name and returns that name. */
export function commitFile(productId: string, kind: MediaKind, tmp: string, ext: string): string {
  const fileName = `${randomUUID()}.${ext.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
  fs.renameSync(tmp, mediaPath(productId, kind, fileName));
  return fileName;
}

export function removeQuietly(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Windows can hold a brief lock on a file that was just read. A leftover
    // file is harmless, and cleanup never fails a job.
  }
}

/**
 * Deletes everything from the previous research run except the files the user
 * uploaded, and any leftover partial downloads.
 */
export function clearResearchFiles(productId: string, keep: string[]): void {
  for (const kind of ["images", "videos"] as const) {
    const dir = path.dirname(mediaPath(productId, kind, "x"));
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!keep.includes(name)) removeQuietly(path.join(dir, name));
    }
  }
}

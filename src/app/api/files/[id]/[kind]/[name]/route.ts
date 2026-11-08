import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { fail } from "@/lib/http";
import { isSafeKind, mediaPath } from "@/lib/storage";

type Params = { params: Promise<{ id: string; kind: string; name: string }> };

const TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

/** Serves stored media to the review pages, with Range support so videos can seek. */
export async function GET(request: Request, { params }: Params) {
  const { id, kind, name } = await params;
  if (!isSafeKind(kind)) return fail("Not found", 404);
  let file: string;
  try {
    file = mediaPath(id, kind, name);
  } catch {
    return fail("Not found", 404);
  }
  const type = TYPES[path.extname(name).toLowerCase()];
  if (!type || !fs.existsSync(file)) return fail("Not found", 404);

  const size = fs.statSync(file).size;
  const headers: Record<string, string> = {
    "content-type": type,
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'",
    "cache-control": "private, max-age=3600",
  };

  const range = request.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    }
    const stream = Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: { ...headers, "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${size}` },
    });
  }
  const stream = Readable.toWeb(fs.createReadStream(file)) as ReadableStream;
  return new Response(stream, { headers: { ...headers, "content-length": String(size) } });
}

import sharp from "sharp";
import { fail } from "@/lib/http";
import * as repo from "@/lib/repo";
import { photoTokenValid } from "@/lib/settings";
import { mediaPath } from "@/lib/storage";
import { whenReady } from "@/lib/supabase";

type Params = { params: Promise<{ id: string; file: string }> };

/**
 * The one route that is reachable through a public tunnel (see proxy.ts). It serves a single
 * product's uploaded photo to Google Lens. The link contains a signed secret that cannot be
 * guessed, and it only ever returns that one photo.
 */
export async function GET(_request: Request, { params }: Params) {
  await whenReady();
  const { id, file } = await params;
  const token = file.replace(/\.jpg$/i, "");
  // Every failure looks the same, so nothing can be learned by guessing.
  const notFound = () => fail("Not found", 404);
  if (!photoTokenValid(id, token)) return notFound();
  const product = repo.getProduct(id);
  if (!product?.input_image) return notFound();

  let bytes: Buffer;
  try {
    // A moderate JPEG is enough for Lens and loads fast.
    bytes = await sharp(mediaPath(id, "images", product.input_image)).rotate().resize(1600, 1600, { fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 88 }).toBuffer();
  } catch {
    return notFound();
  }
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "image/jpeg",
      "content-length": String(bytes.length),
      "cache-control": "private, max-age=600",
      "x-content-type-options": "nosniff",
    },
  });
}

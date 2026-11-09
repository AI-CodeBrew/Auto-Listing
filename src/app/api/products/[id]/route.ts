import { fail, ok, rejectForeignRequest } from "@/lib/http";
import * as repo from "@/lib/repo";
import { pullOne, whenReady } from "@/lib/supabase";

type Params = { params: Promise<{ id: string }> };

const MONEY = /^\d+(\.\d{1,2})?$/;

export const maxDuration = 60;

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  await whenReady();
  await pullOne(id);
  const product = repo.getProduct(id);
  if (!product) return fail("Product not found", 404);
  return ok({
    product,
    images: repo.listImages(id),
    videos: repo.listVideos(id),
    sources: repo.listSources(id).map(({ text: _text, ...source }) => source),
    job: repo.latestJob(id),
  });
}

/** Saves edits from the Listing tab. */
export async function PATCH(request: Request, { params }: Params) {
  await whenReady();
  const refused = rejectForeignRequest(request);
  if (refused) return refused;
  const { id } = await params;
  const product = repo.getProduct(id);
  if (!product) return fail("Product not found", 404);
  if (product.stage !== "listing") return fail("Only products in the Listing tab can be edited here.", 409);
  if (product.shopify_product_id) return fail("This product is already in Shopify. Edit the draft there.", 409);
  if (product.shopify_status === "sending") return fail("This product is being sent to Shopify. Try again when that finishes.", 409);

  const body = (await request.json().catch(() => null)) as {
    name?: string; sku?: string; category?: string; description?: string; price?: string; cost?: string; imageIds?: string[]; videoIds?: string[];
  } | null;
  if (!body) return fail("Invalid request");

  const name = (body.name ?? product.name ?? "").trim();
  const sku = (body.sku ?? product.sku ?? "").trim();
  const price = (body.price ?? product.price ?? "").trim();
  const cost = (body.cost ?? product.cost ?? "").trim();
  if (!name) return fail("The product needs a name.");
  if (!/^[A-Za-z0-9._\-/]{1,64}$/.test(sku)) return fail("SKU can use letters, numbers, dots, dashes, underscores and slashes.");
  if (repo.skuTakenByOther(id, sku)) return fail(`SKU ${sku} is already used by another product.`);
  if (price && !MONEY.test(price)) return fail("Selling price must be a number like 19.99.");
  if (cost && !MONEY.test(cost)) return fail("Cost price must be a number like 7.50.");

  if (body.imageIds) {
    const allowed = new Set(repo.listImages(id).filter((image) => image.selected).map((image) => image.id));
    if (!body.imageIds.every((imageId) => allowed.has(imageId))) return fail("Unknown image.");
    repo.setImageOrder(id, body.imageIds);
  }
  if (body.videoIds) {
    const allowed = new Set(repo.listVideos(id).filter((video) => video.selected).map((video) => video.id));
    if (!body.videoIds.every((videoId) => allowed.has(videoId))) return fail("Unknown video.");
    repo.setVideoOrder(id, body.videoIds);
  }
  repo.updateProduct(id, {
    name,
    sku,
    category: (body.category ?? product.category ?? "").trim() || null,
    description: body.description ?? product.description,
    price: price || null,
    cost: cost || null,
  });
  return ok({ product: repo.getProduct(id) });
}

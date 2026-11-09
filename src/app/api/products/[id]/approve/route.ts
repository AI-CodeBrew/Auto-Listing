import { fail, ok, rejectForeignRequest } from "@/lib/http";
import * as repo from "@/lib/repo";

type Params = { params: Promise<{ id: string }> };

/** "Approve to Listing": saves the user's text and selection and moves the product to Tab 3. */
export async function POST(request: Request, { params }: Params) {
  const refused = rejectForeignRequest(request);
  if (refused) return refused;
  const { id } = await params;
  const product = repo.getProduct(id);
  if (!product) return fail("Product not found", 404);
  if (product.stage !== "review") return fail("Only products in the Review tab can be approved.", 409);

  const body = (await request.json().catch(() => null)) as { name?: string; category?: string; description?: string; imageIds?: string[]; videoIds?: string[] } | null;
  if (!body) return fail("Invalid request");
  const name = (body.name ?? "").trim();
  if (!name) return fail("The product needs a name.");
  const imageIds = body.imageIds ?? [];
  const videoIds = body.videoIds ?? [];

  const images = new Map(repo.listImages(id).map((image) => [image.id, image]));
  if (!imageIds.every((imageId) => images.get(imageId)?.file_name)) return fail("One of the selected images has no file.");
  const videos = new Map(repo.listVideos(id).map((video) => [video.id, video]));
  if (!videoIds.every((videoId) => videos.get(videoId)?.file_name || videos.get(videoId)?.kind === "link")) {
    return fail("One of the selected videos has no file.");
  }

  repo.setImageOrder(id, imageIds);
  repo.setVideoOrder(id, videoIds);
  repo.updateProduct(id, {
    name,
    category: (body.category ?? product.category ?? "").trim() || null,
    description: body.description ?? product.description,
    stage: "listing",
    sku: product.sku ?? repo.nextSku(),
    shopify_status: "ready",
  });
  return ok({ product: repo.getProduct(id) });
}

import { fail, ok, rejectForeignRequest } from "@/lib/http";
import * as repo from "@/lib/repo";
import { whenReady } from "@/lib/supabase";

type Params = { params: Promise<{ id: string }> };

/** "Reject": marks the product rejected. Nothing is sent to Shopify. */
export async function POST(request: Request, { params }: Params) {
  await whenReady();
  const refused = rejectForeignRequest(request);
  if (refused) return refused;
  const { id } = await params;
  const product = repo.getProduct(id);
  if (!product) return fail("Product not found", 404);
  if (product.stage !== "review") return fail("Only products in the Review tab can be rejected.", 409);
  repo.updateProduct(id, { stage: "rejected" });
  return ok({ product: repo.getProduct(id) });
}

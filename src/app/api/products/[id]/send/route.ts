import { fail, ok, rejectForeignRequest } from "@/lib/http";
import * as repo from "@/lib/repo";
import { startSend } from "@/lib/shopify/send";

type Params = { params: Promise<{ id: string }> };

/** Starts creating the Shopify draft. Also used by Retry. The Listing tab polls for the result. */
export async function POST(request: Request, { params }: Params) {
  const refused = rejectForeignRequest(request);
  if (refused) return refused;
  const { id } = await params;
  const result = startSend(id);
  if (!result.started) return fail(result.reason, result.status);
  return ok({ product: repo.getProduct(id) }, 202);
}

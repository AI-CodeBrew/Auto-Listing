import { fail, ok, parseUrlList, rejectForeignRequest } from "@/lib/http";
import * as repo from "@/lib/repo";
import { normalizeUrl } from "@/lib/web/urls";

type Params = { params: Promise<{ id: string }> };

/** "Search Again", retrying a failed job, or continuing a BLOCKED job with pasted URLs. */
export async function POST(request: Request, { params }: Params) {
  const refused = rejectForeignRequest(request);
  if (refused) return refused;
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { urls?: unknown };

  // No await below this line, so two clicks cannot both pass the check and enqueue.
  const product = repo.getProduct(id);
  if (!product) return fail("Product not found", 404);
  if (!["review", "rejected", "failed", "blocked"].includes(product.stage)) {
    return fail("This product cannot be researched again from its current stage.", 409);
  }
  if (repo.hasActiveJob(id)) return fail("Research is already running for this product.", 409);

  const { urls, invalid } = parseUrlList(body.urls);
  if (invalid.length) return fail(`These are not valid web addresses: ${invalid.join(", ")}`);

  const wasBlocked = product.stage === "blocked";
  if (wasBlocked && !urls.length) return fail("Paste at least one product page URL to continue.");

  // A URL pasted again is a deliberate request to try it, so it comes off the blocked list.
  const pasted = new Set(urls.map(normalizeUrl));
  repo.updateProduct(id, {
    stage: "researching",
    input_urls: [...new Set([...product.input_urls, ...urls])],
    blocked_urls: product.blocked_urls.filter((url) => !pasted.has(normalizeUrl(url))),
  });
  // After a block, searching again would hit the same block, so only the URLs are used.
  const job = repo.enqueueJob(id, wasBlocked);
  return ok({ job }, 202);
}

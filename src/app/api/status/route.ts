import { aiStatus } from "@/lib/ai";
import { ok } from "@/lib/http";
import * as repo from "@/lib/repo";
import { missingShopifySettings } from "@/lib/shopify/client";

/** Tab counts and setup state. Reports only which settings are missing, never their values. */
export async function GET() {
  return ok({
    counts: repo.countByStage(),
    ai: await aiStatus(),
    shopifyMissing: missingShopifySettings(),
  });
}

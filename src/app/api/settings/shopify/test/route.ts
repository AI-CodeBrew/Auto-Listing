import { fail, ok, rejectForeignRequest } from "@/lib/http";
import { ShopifyError, testShopifyConnection } from "@/lib/shopify/client";
import { whenReady } from "@/lib/supabase";

/** Tries the saved details against Shopify and reports what happened in plain words. */
export async function POST(request: Request) {
  await whenReady();
  const refused = rejectForeignRequest(request);
  if (refused) return refused;
  try {
    const result = await testShopifyConnection();
    return ok(result);
  } catch (error) {
    if (error instanceof ShopifyError) return fail(error.message, 422);
    return fail(error instanceof Error ? error.message : String(error), 500);
  }
}

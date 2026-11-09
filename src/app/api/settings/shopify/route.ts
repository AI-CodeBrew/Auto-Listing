import { fail, ok, rejectForeignRequest } from "@/lib/http";
import { clearShopifyCredentials, isValidDomain, normalizeDomain, saveShopifyCredentials, shopifyCredentials, shopifySummary } from "@/lib/settings";
import { clearTokenCache } from "@/lib/shopify/client";
import { whenReady } from "@/lib/supabase";

/** Shows what is saved. The client secret is never included, only whether one exists. */
export async function GET() {
  await whenReady();
  return ok(shopifySummary());
}

/** Saves the store details. Leave the secret empty to keep the one already saved. */
export async function PUT(request: Request) {
  await whenReady();
  const refused = rejectForeignRequest(request);
  if (refused) return refused;

  const body = (await request.json().catch(() => null)) as { domain?: unknown; clientId?: unknown; clientSecret?: unknown } | null;
  const domain = normalizeDomain(String(body?.domain ?? ""));
  const clientId = String(body?.clientId ?? "").trim();
  const clientSecret = String(body?.clientSecret ?? "").trim();

  if (!domain) return fail("Enter your store domain, for example my-store.myshopify.com.");
  if (!isValidDomain(domain)) return fail(`"${domain}" does not look like a store domain. Use the form my-store.myshopify.com.`);
  if (!clientId) return fail("Enter the Client ID from your Shopify app.");
  if (!clientSecret && !shopifyCredentials().clientSecret) return fail("Enter the Client secret from your Shopify app.");

  saveShopifyCredentials({ domain, clientId, clientSecret });
  clearTokenCache();
  return ok(shopifySummary());
}

/** Forgets the details saved on the page. */
export async function DELETE(request: Request) {
  await whenReady();
  const refused = rejectForeignRequest(request);
  if (refused) return refused;
  clearShopifyCredentials();
  clearTokenCache();
  return ok(shopifySummary());
}

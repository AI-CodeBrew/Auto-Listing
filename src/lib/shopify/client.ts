import { config } from "../config";
import { shopifyCredentials } from "../settings";

/** Shopify Admin GraphQL client using the client credentials grant. */
export class ShopifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShopifyError";
  }
}

interface TokenCache {
  key: string;
  token: string;
  /** Time in ms after which we fetch a new token. */
  refreshAt: number;
}

// Shopify tokens last 24 hours. Refreshing early means a long upload never has its
// token expire partway through.
const REFRESH_MARGIN_MS = 5 * 60_000;
const holder = globalThis as unknown as { __plaShopifyToken?: TokenCache };

/** Names of the missing fields, as they are labelled on the Shopify page. */
export function missingShopifySettings(): string[] {
  const creds = shopifyCredentials();
  const missing: string[] = [];
  if (!creds.domain) missing.push("Store domain");
  if (!creds.clientId) missing.push("Client ID");
  if (!creds.clientSecret) missing.push("Client secret");
  return missing;
}

/** Base address of the store. Tests point this at a mock server. */
export function shopifyBaseUrl(domain = shopifyCredentials().domain): string {
  return config.shopifyBaseUrlOverride() || `https://${domain}`;
}

export function clearTokenCache(): void {
  holder.__plaShopifyToken = undefined;
}

async function getToken(forceNew = false): Promise<string> {
  const creds = shopifyCredentials();
  const key = `${creds.domain}|${creds.clientId}|${creds.clientSecret}`;
  const cached = holder.__plaShopifyToken;
  if (!forceNew && cached && cached.key === key && Date.now() < cached.refreshAt) return cached.token;

  let response: Response;
  try {
    response = await fetch(`${shopifyBaseUrl(creds.domain)}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      // Shopify ignores a scope parameter. The token carries what the store granted the app.
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new ShopifyError(`Could not reach Shopify to get an access token: ${errorText(error)}`);
  }
  const body = await response.text();
  if (!response.ok) {
    if (body.includes("shop_not_permitted")) {
      throw new ShopifyError("Shopify refused the token: the app and the store must belong to the same organization, and the app must be installed on the store.");
    }
    throw new ShopifyError(`Shopify refused the access token request (HTTP ${response.status}). Check the store domain, client ID and client secret on the Shopify page. ${body.slice(0, 200)}`);
  }
  const data = JSON.parse(body) as { access_token: string; expires_in?: number };
  const lifetimeMs = (data.expires_in ?? 86_399) * 1000;
  holder.__plaShopifyToken = {
    key,
    token: data.access_token,
    refreshAt: Date.now() + Math.max(0, lifetimeMs - REFRESH_MARGIN_MS),
  };
  return data.access_token;
}

interface GraphqlResponse<T> {
  data?: T;
  errors?: { message: string; extensions?: { code?: string } }[];
}

const MAX_THROTTLE_RETRIES = 4;

/**
 * Sends one GraphQL operation. It retries only when Shopify says the request did not
 * run (THROTTLED or 401). A timeout or 5xx on a mutation might have worked, so those
 * surface to the user, and Retry checks Shopify before creating anything.
 */
export async function graphql<T>(query: string, variables: Record<string, unknown>, timeoutMs = 120_000): Promise<T> {
  let forceNewToken = false;
  for (let attempt = 0; ; attempt++) {
    const token = await getToken(forceNewToken);
    forceNewToken = false;
    let response: Response;
    try {
      response = await fetch(`${shopifyBaseUrl()}/admin/api/${config.shopifyApiVersion()}/graphql.json`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-shopify-access-token": token },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ShopifyError(`Could not reach Shopify: ${errorText(error)}`);
    }

    if (response.status === 401 && attempt === 0) {
      await response.body?.cancel();
      forceNewToken = true;
      continue;
    }
    if (response.status === 429 && attempt < MAX_THROTTLE_RETRIES) {
      await response.body?.cancel();
      await backoff(Number(response.headers.get("retry-after")) * 1000 || 2000 * (attempt + 1));
      continue;
    }
    const text = await response.text();
    if (!response.ok) {
      if (response.status === 403) {
        throw new ShopifyError(`Shopify denied access (HTTP 403). Check the app has the write_products and write_inventory scopes and is installed on this store. ${text.slice(0, 200)}`);
      }
      throw new ShopifyError(`Shopify returned HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    const parsed = JSON.parse(text) as GraphqlResponse<T>;
    if (parsed.errors?.length) {
      const throttled = parsed.errors.some((e) => e.extensions?.code === "THROTTLED");
      if (throttled && attempt < MAX_THROTTLE_RETRIES) {
        await backoff(2000 * (attempt + 1));
        continue;
      }
      throw new ShopifyError(`Shopify GraphQL error: ${parsed.errors.map((e) => e.message).join("; ")}`);
    }
    if (!parsed.data) throw new ShopifyError("Shopify returned an empty response.");
    return parsed.data;
  }
}

function backoff(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Checks the saved details by asking Shopify for a token and the shop's name, and
 * which of the needed permissions the app was granted.
 */
export async function testShopifyConnection(): Promise<{ shopName: string; domain: string; missingScopes: string[] }> {
  const missing = missingShopifySettings();
  if (missing.length) throw new ShopifyError(`Fill in: ${missing.join(", ")}.`);
  clearTokenCache();
  const data = await graphql<{ shop: { name: string }; currentAppInstallation: { accessScopes: { handle: string }[] } }>(
    "query ConnectionTest { shop { name } currentAppInstallation { accessScopes { handle } } }",
    {},
    30_000,
  );
  const granted = new Set(data.currentAppInstallation.accessScopes.map((scope) => scope.handle));
  // write_* scopes include the matching read_* scope.
  const missingScopes = ["write_products", "write_inventory"].filter((scope) => !granted.has(scope));
  return { shopName: data.shop.name, domain: shopifyCredentials().domain, missingScopes };
}

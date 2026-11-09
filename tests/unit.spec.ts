import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { hammingDistance, perceptualHash } from "../src/lib/media/images";
import { chooseBestImages, findCopiedPhrases, finalizeListing, removeStoreWords } from "../src/lib/pipeline/text";
import { descriptionToHtml, toPlainText } from "../src/lib/sanitize";
import { money, priceUsage } from "../src/lib/costs";
import { unwrapBingLink } from "../src/lib/search/bing";
import { marketplaceOfHit, takeMarketplacePhotos } from "../src/lib/search/marketplaces";
import { videoSearchArguments, videosFromPayload } from "../src/lib/search/fastmoss";
import { buildProductInput, makeHandle } from "../src/lib/shopify/send";
import { fullSizeGuesses, largestFromSrcset, looksLikeIconOrLogo } from "../src/lib/web/extract";
import { isPrivateAddress, isPublicUrl } from "../src/lib/web/net";
import { classifyVideo, exclusionReason, filterProductUrls, normalizeUrl, videoExtension } from "../src/lib/web/urls";
import { clearTokenCache, graphql } from "../src/lib/shopify/client";
import { isValidDomain, normalizeDomain, saveShopifyCredentials, shopifyCredentials, clearShopifyCredentials, shopifySummary } from "../src/lib/settings";
import { testShopifyConnection } from "../src/lib/shopify/client";
import { MOCK_URL } from "./mock/server";
import path from "node:path";
import { mockReset, mockSet, mockState, TEST_DIR } from "./helpers";

// Unit tests get their own database, so they never touch the real ./data folder.
process.env.APP_DATA_DIR = path.join(TEST_DIR, "unit", "data");

test.describe("video rules", () => {
  test("platform videos are links only, never files", () => {
    for (const [url, provider] of [
      ["https://www.youtube.com/embed/abc123", "youtube"],
      ["https://youtu.be/abc123", "youtube"],
      ["https://www.youtube.com/watch?v=abc123&t=3", "youtube"],
      ["https://player.vimeo.com/video/1234567", "vimeo"],
      ["https://www.tiktok.com/@a/video/1.mp4", "tiktok"],
      ["https://www.instagram.com/reel/x/video.mp4", "instagram"],
      ["https://www.facebook.com/x/videos/1.mp4", "facebook"],
      ["https://fb.watch/abc.mp4", "facebook"],
    ] as const) {
      const result = classifyVideo(url);
      expect(result?.kind, url).toBe("link");
      expect(result && result.kind === "link" && result.provider, url).toBe(provider);
    }
  });
  test("platform CDN files are refused, even with a video extension", () => {
    for (const url of ["https://rr1.googlevideo.com/x.mp4", "https://v.fbcdn.net/x.mp4", "https://a.cdninstagram.com/x.mp4", "https://v16.tiktokcdn.com/x.mp4"]) {
      expect(classifyVideo(url), url).toBeNull();
    }
  });
  test("only direct MP4, MOV and WEBM can be files", () => {
    expect(classifyVideo("https://shop.example/a.MP4")?.kind).toBe("file");
    expect(classifyVideo("https://shop.example/a.mov?x=1")?.kind).toBe("file");
    expect(classifyVideo("https://shop.example/a.webm")?.kind).toBe("file");
    expect(classifyVideo("https://shop.example/a.m3u8")).toBeNull();
    expect(classifyVideo("blob:https://shop.example/1")).toBeNull();
  });
  test("an HTML page at a .mp4 URL is not treated as video", () => {
    expect(videoExtension("text/html", "https://a.example/v.mp4")).toBeNull();
    expect(videoExtension("video/webm", "https://a.example/v")).toBe("webm");
    expect(videoExtension("application/octet-stream", "https://a.example/v.mov")).toBe("mov");
  });
});

test.describe("URL filtering", () => {
  test("removes blogs, social pages and duplicates", () => {
    const seen = new Set<string>();
    const { keep, dropped } = filterProductUrls(
      [
        "https://shop.example/p/1?utm_source=x",
        "https://www.shop.example/p/1/",
        "http://shop.example/p/1#top",
        "https://shop.example/p/2?color=red",
        "https://shop.example/blog/post",
        "https://blog.shop.example/p",
        "https://someone.medium.com/bottles",
        "https://m.facebook.com/x",
        "https://x.com/y",
        "https://www.pinterest.com/pin/1",
      ],
      seen,
    );
    expect(keep).toEqual(["https://shop.example/p/1?utm_source=x", "https://shop.example/p/2?color=red"]);
    expect(dropped).toHaveLength(6);
  });
  test("variants with real parameters stay different pages", () => {
    expect(normalizeUrl("https://a.example/p?color=red")).not.toBe(normalizeUrl("https://a.example/p?color=blue"));
  });
  test("non-web URLs are excluded", () => {
    expect(exclusionReason("javascript:alert(1)")).toBeTruthy();
    expect(exclusionReason("file:///c:/secret")).toBeTruthy();
  });
  test("Bing redirect links are decoded rather than followed", () => {
    const target = "https://shop.example/p/1";
    const wrapped = `https://www.bing.com/ck/a?!&&p=abc&u=a1${Buffer.from(target).toString("base64url")}&ntb=1`;
    expect(unwrapBingLink(wrapped)).toBe(target);
    expect(unwrapBingLink("https://www.bing.com/search?q=more")).toBeNull();
    expect(unwrapBingLink(target)).toBe(target);
    expect(unwrapBingLink(`https://www.bing.com/ck/a?u=a1${Buffer.from("javascript:alert(1)").toString("base64url")}`)).toBeNull();
  });
});

test.describe("untrusted pages cannot reach local services", () => {
  test("private addresses are recognized", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.1", "169.254.169.254", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "0.0.0.0"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
  test("local URLs are refused", async () => {
    delete process.env.ALLOW_PRIVATE_NETWORK;
    expect(await isPublicUrl("http://localhost:3000/api/products")).toBe(false);
    expect(await isPublicUrl("http://127.0.0.1:3000/")).toBe(false);
    expect(await isPublicUrl("http://[::1]:3000/")).toBe(false);
    expect(await isPublicUrl("http://169.254.169.254/latest/meta-data")).toBe(false);
    expect(await isPublicUrl("file:///c:/windows/win.ini")).toBe(false);
  });
});

test.describe("image helpers", () => {
  test("srcset picks the largest", () => {
    expect(largestFromSrcset("a.jpg 100w, b.jpg 1600w, c.jpg 800w")).toBe("b.jpg");
    expect(largestFromSrcset("a.jpg 1x, b.jpg 2x")).toBe("b.jpg");
  });
  test("full-size URLs are guessed for common CDNs", () => {
    expect(fullSizeGuesses("https://cdn.shopify.com/s/files/photo_400x400.jpg?v=1")).toEqual(["https://cdn.shopify.com/s/files/photo.jpg?v=1"]);
    expect(fullSizeGuesses("https://a.example/wp-content/photo-300x300.jpg")).toEqual(["https://a.example/wp-content/photo.jpg"]);
    expect(fullSizeGuesses("https://m.media-amazon.com/images/I/abc._AC_SX300_.jpg")).toEqual(["https://m.media-amazon.com/images/I/abc.jpg"]);
    expect(fullSizeGuesses("https://a.example/photo.jpg?width=200")).toEqual(["https://a.example/photo.jpg"]);
    expect(fullSizeGuesses("https://a.example/photo.jpg")).toEqual([]);
  });
  test("icons and logos are recognized", () => {
    for (const url of ["https://a.example/logo.png", "https://a.example/img/site-logo-2.jpg", "https://a.example/x.svg", "https://a.example/favicon.ico", "https://a.example/icons/cart.png"]) {
      expect(looksLikeIconOrLogo(url), url).toBe(true);
    }
    expect(looksLikeIconOrLogo("https://a.example/product/bottle.jpg")).toBe(false);
    expect(looksLikeIconOrLogo("https://a.example/p.jpg", "Company logo")).toBe(true);
  });
  test("perceptual hash matches resized copies and separates different pictures", async () => {
    const svg = (a: string, b: string, shape: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1600"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="1600" height="1600" fill="url(#g)"/>${shape}</svg>`);
    const picture = svg("#dfe6e9", "#636e72", '<circle cx="600" cy="700" r="420" fill="#d63031"/><rect x="900" y="200" width="400" height="1100" fill="#0984e3"/>');
    const different = svg("#2d3436", "#ffeaa7", '<rect x="100" y="900" width="1300" height="400" fill="#00b894"/><circle cx="1200" cy="400" r="260" fill="#fdcb6e"/>');
    const make = (input: Buffer, size: number, quality: number) => sharp(input).resize(size, size).jpeg({ quality }).toBuffer();
    const big = await perceptualHash(await make(picture, 1200, 90));
    const small = await perceptualHash(await make(picture, 900, 60));
    const other = await perceptualHash(await make(different, 1200, 90));
    expect(hammingDistance(big, small)).toBeLessThanOrEqual(6);
    expect(hammingDistance(big, other)).toBeGreaterThan(6);
  });
  test("best images: own upload first, then quality, capped", () => {
    const image = (id: string, quality: number, passed = true, uploaded = false) => ({ id, passed, uploaded, width: 1000, height: 1000, checks: { quality } });
    const list = [image("a", 50), image("b", 90), image("fail", 99, false), image("own", 10, true, true), ...Array.from({ length: 12 }, (_, i) => image(`x${i}`, 40))];
    const best = chooseBestImages(list, 10);
    expect(best).toHaveLength(10);
    expect(best.slice(0, 3)).toEqual(["own", "b", "a"]);
    expect(best).not.toContain("fail");
  });
});

test.describe("text rules", () => {
  const draft = {
    best_name: "ShopMart Steel Bottle | ShopMart",
    name_options: ["Steel Bottle - ShopMart", "Insulated Bottle", "Steel Bottle"],
    category: "ShopMart Drinkware",
    description: "A strong bottle. It is BPA-free and food safe. Rated 4.8 by buyers. Customers love it.",
    feature_bullets: ["- Dishwasher-safe body", "Steel lid", "4.5 stars overall", "Bestseller in its class"],
    claims_needing_check: ["food safe"],
  };

  test("store words, reviews and unconfirmed claims are handled", () => {
    const result = finalizeListing(draft, ["ShopMart"], "fallback");
    expect(result.name).toBe("Steel Bottle");
    expect(result.category).toBe("Drinkware");
    expect(result.nameOptions).toEqual(["Insulated Bottle"]);
    expect(result.description).toContain("BPA-free [needs checking]");
    expect(result.description).toContain("food safe [needs checking]");
    expect(result.description).toContain("- Dishwasher-safe [needs checking] body");
    expect(result.description).toContain("- Steel lid");
    expect(result.description).not.toMatch(/Rated|love|stars|Bestseller/i);
    expect(result.claims.map((c) => c.toLowerCase()).sort()).toEqual(["bpa-free", "dishwasher-safe", "food safe"]);
  });
  test("removing store words leaves real product words alone", () => {
    expect(removeStoreWords("Target Practice Set - Target", ["Target"])).toBe("Practice Set");
    expect(removeStoreWords("Bottle (Amazon)", ["Amazon"])).toBe("Bottle");
    expect(removeStoreWords("Steel Bottle", ["Steelworks"])).toBe("Steel Bottle");
  });
  test("long copied phrases are detected", () => {
    const source = "This amazing insulated bottle keeps your drinks perfectly cold for twenty four hours straight.";
    expect(findCopiedPhrases("Our bottle keeps your drinks perfectly cold for twenty four hours straight, always.", [source])).toHaveLength(1);
    expect(findCopiedPhrases("A double-wall flask that stays chilly all day long.", [source])).toEqual([]);
  });
  test("HTML is removed from saved text and escaped in Shopify text", () => {
    expect(toPlainText("<p>Hi <b>there</b></p><script>alert(1)</script><style>x{}</style>")).toBe("Hi there");
    expect(toPlainText('<img src=x onerror="alert(1)">Text')).toBe("Text");
    expect(descriptionToHtml('Intro <script>alert(1)</script>\n\n- One\n- Two & "three"\n\nOutro')).toBe(
      '<p>Intro &lt;script&gt;alert(1)&lt;/script&gt;</p><ul><li>One</li><li>Two &amp; &quot;three&quot;</li></ul><p>Outro</p>',
    );
  });
});

test.describe("Shopify input", () => {
  const product: any = { id: "12345678-aaaa", name: "Steel Bottle", sku: "PRD-0001", price: null, cost: null, description: "Hi", shopify_handle: "steel-bottle", seller_name: "SomeStore" };

  test("status is always DRAFT and vendor is never set, whatever the product row holds", () => {
    const input = buildProductInput({ product: { ...product, status: "ACTIVE", vendor: "SomeStore" }, imageSources: [], fileVideoSources: [], externalVideos: [] });
    expect(input.status).toBe("DRAFT");
    expect(input).not.toHaveProperty("vendor");
    expect(JSON.stringify(input)).not.toContain("SomeStore");
    expect(input.variants[0].price).toBe("0.00");
  });
  test("handles are valid and stay unique per product", () => {
    expect(makeHandle(product)).toBe("steel-bottle-prd-0001-12345678");
    expect(makeHandle({ ...product, name: "!!!" })).toBe("product-prd-0001-12345678");
    expect(makeHandle({ ...product, name: "Bouteille d'été" })).toBe("bouteille-d-ete-prd-0001-12345678");
  });
});

test.describe("Shopify token", () => {
  test.beforeEach(async () => {
    await mockReset();
    clearTokenCache();
    clearShopifyCredentials();
    Object.assign(process.env, {
      SHOPIFY_STORE_DOMAIN: "mock-store.myshopify.com",
      SHOPIFY_CLIENT_ID: "mock-client",
      SHOPIFY_CLIENT_SECRET: "mock-secret",
      SHOPIFY_BASE_URL_OVERRIDE: MOCK_URL,
    });
  });
  const QUERY = "query FindDraftByHandle($identifier: ProductIdentifierInput!) { productByIdentifier(identifier: $identifier) { id } }";
  const VARS = { identifier: { handle: "x" } };

  test("the token uses the client credentials grant and is cached", async () => {
    await graphql(QUERY, VARS);
    await graphql(QUERY, VARS);
    await graphql(QUERY, VARS);
    const { oauthCalls } = await mockState();
    expect(oauthCalls).toHaveLength(1);
    // Exactly these fields. Shopify ignores a scope parameter, so none is sent.
    expect(oauthCalls[0]).toEqual({ grant_type: "client_credentials", client_id: "mock-client", client_secret: "mock-secret" });
  });
  test("the token is refreshed before it expires", async () => {
    // Expires in 4 minutes, which is inside the 5-minute refresh margin.
    await mockSet({ tokenExpiresIn: 240 });
    await graphql(QUERY, VARS);
    await graphql(QUERY, VARS);
    expect((await mockState()).oauthCalls).toHaveLength(2);
  });
  test("wrong credentials give a clear error", async () => {
    process.env.SHOPIFY_CLIENT_SECRET = "wrong";
    await expect(graphql(QUERY, VARS)).rejects.toThrow(/client secret/);
  });
  test("details saved on the page win over .env, and the secret is never in the summary", async () => {
    saveShopifyCredentials({ domain: "https://Page-Store.myshopify.com/admin", clientId: "page-client", clientSecret: "page-secret" });
    expect(shopifyCredentials()).toEqual({ domain: "page-store.myshopify.com", clientId: "page-client", clientSecret: "page-secret" });
    const summary = shopifySummary();
    expect(summary).toEqual({ domain: "page-store.myshopify.com", clientId: "page-client", hasSecret: true, source: "page" });
    expect(JSON.stringify(summary)).not.toContain("page-secret");

    // Saving again with an empty secret keeps the saved one.
    saveShopifyCredentials({ domain: "page-store", clientId: "page-client-2", clientSecret: "" });
    expect(shopifyCredentials().clientSecret).toBe("page-secret");

    clearShopifyCredentials();
    expect(shopifyCredentials().clientId).toBe("mock-client"); // back to .env
    expect(shopifySummary().source).toBe("env");
  });
  test("domains are tidied and checked", () => {
    expect(normalizeDomain("  my-store ")).toBe("my-store.myshopify.com");
    expect(normalizeDomain("https://My-Store.myshopify.com/admin/products")).toBe("my-store.myshopify.com");
    expect(isValidDomain("my-store.myshopify.com")).toBe(true);
    expect(isValidDomain("not a domain")).toBe(false);
    expect(isValidDomain("")).toBe(false);
  });
  test("the connection test reports the shop name and missing permissions", async () => {
    expect(await testShopifyConnection()).toEqual({ shopName: "Mock Store", domain: "mock-store.myshopify.com", missingScopes: [] });
    await mockSet({ scopes: ["write_products"] });
    expect((await testShopifyConnection()).missingScopes).toEqual(["write_inventory"]);
  });
});

test.describe("search cost and FastMoss videos", () => {
  test("an uploaded photo keeps at most 20 pictures from Amazon, AliExpress and Alibaba", () => {
    expect(marketplaceOfHit({ original: "https://m.media-amazon.com/images/I/bottle.jpg", pageUrl: "https://www.amazon.com/dp/B001" })?.id).toBe("amazon");
    expect(marketplaceOfHit({ original: "https://example.com/a.jpg", pageUrl: "", source: "AliExpress" })?.label).toBe("AliExpress");
    expect(marketplaceOfHit({ original: "https://cdn.example.com/a.jpg", pageUrl: "https://shop.example.com/p/1", source: "Good Store" })).toBeNull();

    const photo = (original: string) => ({ original });
    const amazon = [photo("a1"), photo("a2"), photo("a3")];
    const aliExpress = [photo("e1"), photo("a1")];
    const alibaba = [photo("b1")];
    expect(takeMarketplacePhotos([amazon, aliExpress, alibaba], 20).map((hit) => hit.original)).toEqual(["a1", "e1", "b1", "a2", "a3"]);
    expect(takeMarketplacePhotos([amazon, aliExpress, alibaba], 2)).toHaveLength(2);
  });

  test("a request price is photos plus AI tokens, with FastMoss counted in credits", () => {
    const cost = priceUsage({ serpapi: 2, fastmoss: 1, aiInput: 1_000_000, aiOutput: 500_000 });
    expect(cost.serpapiUsd).toBe(0);
    expect(cost.aiUsd).toBeCloseTo(0.1 + 0.25);
    expect(cost.totalUsd).toBeCloseTo(0.35);
    expect(cost.fastmossCredits).toBe(1);
    expect(money(cost.totalUsd)).toBe("$0.3500");
  });

  test("video search arguments follow the tool schema", () => {
    expect(videoSearchArguments(undefined, "steel bottle")).toEqual({ keywords: "steel bottle", region: "US" });
    expect(videoSearchArguments({ properties: { keyword: { type: "string" }, region: { type: "string", enum: ["US", "GB"] } }, required: ["keyword"] }, "bottle")).toEqual({
      keyword: "bottle",
      region: "US",
    });
  });

  test("video results keep TikTok links and skip pictures", () => {
    const hits = videosFromPayload({
      list: [
        { title: "Bottle demo", unique_id: "shop", video_id: "123", cover: "https://cdn.example.com/a.jpg", fastmoss_url: "https://www.fastmoss.com/video/123" },
        { url: "https://shop.example.com/about" },
      ],
    });
    expect(hits).toEqual([
      {
        url: "https://www.tiktok.com/@shop/video/123",
        title: "Bottle demo",
        creator: "shop",
        pageUrl: "https://www.fastmoss.com/video/123",
      },
    ]);
  });
});

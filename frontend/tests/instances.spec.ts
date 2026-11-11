import http from "node:http";
import type { ChildProcess } from "node:child_process";
import { expect, test } from "@playwright/test";
import { MOCK_URL } from "./mock/server";
import { IMAGE_FILE, VIDEO_FILE, createProduct, detail, killApp, mockReset, mockState, startApp, toListing, waitForStage } from "./helpers";

const PORT = 3101;
const BASE = `http://localhost:${PORT}`;

test.beforeEach(async () => {
  await mockReset();
});

test("job status survives an app restart", async ({ request }) => {
  let app: ChildProcess = await startApp("restart", PORT);
  try {
    // Page 1 of this search takes 15 seconds, which leaves time to kill the app mid-job.
    const running = await createProduct(request, { name: "slowjob bottle" }, BASE);
    const waiting = await createProduct(request, { name: "Steel Bottle" }, BASE);
    await expect.poll(async () => (await detail(request, running, BASE)).job.status, { timeout: 30_000 }).toBe("RUNNING");
    await expect.poll(async () => (await detail(request, running, BASE)).job.step, { timeout: 30_000 }).toContain("Opening page 1");
    // One at a time: the second job waits while the first runs.
    expect((await detail(request, waiting, BASE)).job.status).toBe("QUEUED");

    killApp(app);
    app = await startApp("restart", PORT);

    // Both jobs are still known after the restart, and both finish.
    const recovered = await waitForStage(request, running, "review", BASE);
    expect(recovered.job.status).toBe("DONE");
    expect(recovered.job.attempts).toBe(2);
    expect(recovered.job.log.some((entry: any) => entry.text.includes("App restarted"))).toBe(true);
    const second = await waitForStage(request, waiting, "review", BASE);
    expect(second.job.attempts).toBe(1);
  } finally {
    killApp(app);
  }
});

test("a send interrupted by a restart can be retried without a duplicate", async ({ request }) => {
  let app: ChildProcess = await startApp("send-restart", PORT);
  try {
    const listed = await toListing(request, { name: "Steel Bottle Deluxe" }, BASE);
    const id = listed.product.id;
    await fetch(`${MOCK_URL}/__set`, { method: "POST", body: JSON.stringify({ productSetDelayMs: 4000 }) });
    expect((await request.post(`${BASE}/api/products/${id}/send`, { data: {} })).status()).toBe(202);
    await expect.poll(async () => (await detail(request, id, BASE)).product.shopify_status).toBe("sending");
    await expect.poll(async () => (await mockState()).graphql.some((call) => call.name === "CreateDraftProduct"), { timeout: 15_000 }).toBe(true);

    killApp(app);
    app = await startApp("send-restart", PORT);
    await fetch(`${MOCK_URL}/__set`, { method: "POST", body: JSON.stringify({ productSetDelayMs: 0 }) });

    const interrupted = await detail(request, id, BASE);
    expect(interrupted.product.shopify_status).toBe("error");
    expect(interrupted.product.shopify_error).toContain("Retry");

    // The mock finished creating it despite the crash, so Retry must adopt that product.
    await expect.poll(async () => (await mockState()).products.length, { timeout: 15_000 }).toBe(1);
    expect((await request.post(`${BASE}/api/products/${id}/send`, { data: {} })).status()).toBe(202);
    await expect.poll(async () => (await detail(request, id, BASE)).product.shopify_status).toBe("draft");
    expect((await mockState()).products).toHaveLength(1);
  } finally {
    killApp(app);
  }
});

test.describe("a search engine whose robots.txt forbids /search, as bing.com's does today", () => {
  const SEARCH_PORT = 4101;
  let server: http.Server;
  let hits: string[] = [];

  test.beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url!);
      if (req.url === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nDisallow: /search\nDisallow: /ck/\n");
      } else {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<h1>search page</h1>");
      }
    });
    await new Promise<void>((resolve) => server.listen(SEARCH_PORT, "127.0.0.1", resolve));
  });
  test.afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  test("no search request is made: BLOCKED without URLs, and pasted URLs carry on", async ({ request }) => {
    const app = await startApp("robots", PORT, { BING_BASE_URL_OVERRIDE: `http://127.0.0.1:${SEARCH_PORT}`, SHOPIFY_CLIENT_ID: "" });
    try {
      hits = [];
      // Name only: nothing to go on, so ask for URLs.
      const nameOnly = await createProduct(request, { name: "Steel Bottle" }, BASE);
      const blocked = await waitForStage(request, nameOnly, "blocked", BASE);
      expect(blocked.job.status).toBe("BLOCKED");
      expect(blocked.job.message).toContain("robots.txt");
      expect(blocked.job.message).toContain("Paste product page URLs");
      expect(hits).toEqual(["/robots.txt"]);

      // Pasting URLs reaches Review.
      await request.post(`${BASE}/api/products/${nameOnly}/research`, { data: { urls: [`${MOCK_URL}/p/good-1`, `${MOCK_URL}/p/good-2`] } });
      const resumed = await waitForStage(request, nameOnly, "review", BASE);
      expect(resumed.sources.filter((s: any) => s.status === "accepted")).toHaveLength(2);

      // URLs given from the start: research continues, with a warning that search was skipped.
      const withUrls = await createProduct(request, { name: "Steel Bottle", urls: [`${MOCK_URL}/p/good-3`] }, BASE);
      const reviewed = await waitForStage(request, withUrls, "review", BASE);
      expect(reviewed.product.warnings.join(" ")).toContain("robots.txt");
      expect(hits.filter((hit) => hit.startsWith("/search"))).toEqual([]);

      // Also covers missing Shopify settings: a clear error, with nothing sent.
      await request.post(`${BASE}/api/products/${withUrls}/approve`, { data: { name: "x", imageIds: [], videoIds: [] } });
      const send = await request.post(`${BASE}/api/products/${withUrls}/send`, { data: {} });
      expect(send.status()).toBe(400);
      const failed = await detail(request, withUrls, BASE);
      expect(failed.product.shopify_status).toBe("error");
      expect(failed.product.shopify_error).toContain("Client ID");
      expect((await mockState()).oauthCalls).toHaveLength(0);
    } finally {
      killApp(app);
    }
  });
});

test("a missing AI key fails the job with a clear message", async ({ request }) => {
  const app = await startApp("no-ai", PORT, { AI_API_KEY: "" });
  try {
    const id = await createProduct(request, { name: "Steel Bottle" }, BASE);
    const failed = await waitForStage(request, id, "failed", BASE);
    expect(failed.job.status).toBe("FAILED");
    expect(failed.job.message).toContain("AI_API_KEY");
    expect((await mockState()).searches).toEqual([]);
  } finally {
    killApp(app);
  }
});

test("the Shopify page saves details, hides the secret and tests the connection", async ({ page, request }) => {
  // No .env values, so everything comes from the page.
  const app = await startApp("shopify-page", PORT, { SHOPIFY_STORE_DOMAIN: "", SHOPIFY_CLIENT_ID: "", SHOPIFY_CLIENT_SECRET: "" });
  try {
    await page.goto(`${BASE}/shopify`);
    await page.getByRole("button", { name: "Shopify" }).click();
    await expect(page.getByTestId("shopify-connection-state")).toHaveText("Not connected");
    await expect(page.getByTestId("shopify-test")).toBeDisabled();

    // Missing fields and a bad domain are refused with a clear message.
    await page.getByTestId("shopify-save").click();
    await expect(page.getByTestId("shopify-form-error")).toContainText("store domain");
    await page.getByTestId("shopify-domain").fill("not a domain");
    await page.getByTestId("shopify-client-id").fill("mock-client");
    await page.getByTestId("shopify-client-secret").fill("mock-secret");
    await page.getByTestId("shopify-save").click();
    await expect(page.getByTestId("shopify-form-error")).toContainText("does not look like");

    // A store name alone is completed.
    await page.getByTestId("shopify-domain").fill("mock-store");
    await page.getByTestId("shopify-save").click();
    await expect(page.getByTestId("shopify-connection-state")).toHaveText("Details saved");
    await expect(page.getByTestId("shopify-domain")).toHaveValue("mock-store.myshopify.com");
    await expect(page.getByTestId("shopify-client-secret")).toHaveValue("");

    // The secret never comes back from the server.
    const summary = await (await request.get(`${BASE}/api/settings/shopify`)).text();
    expect(summary).not.toContain("mock-secret");
    expect(JSON.parse(summary)).toMatchObject({ domain: "mock-store.myshopify.com", clientId: "mock-client", hasSecret: true, source: "page" });
    expect(await (await request.get(`${BASE}/api/status`)).text()).not.toContain("mock-secret");

    await page.getByTestId("shopify-test").click();
    await expect(page.getByTestId("shopify-test-result")).toContainText("Connected to Mock Store");

    // Wrong secret: Shopify refuses and the page says so.
    await page.getByTestId("shopify-client-secret").fill("wrong");
    await page.getByTestId("shopify-save").click();
    await page.getByTestId("shopify-test").click();
    await expect(page.getByTestId("shopify-form-error")).toContainText("client secret");

    // The other way: an Admin API access token.
    await page.getByTestId("shopify-method-token").click();
    await expect(page.getByTestId("shopify-client-id")).toHaveCount(0);
    await expect(page.getByTestId("shopify-help")).toContainText("Develop apps");
    await page.getByTestId("shopify-save").click();
    await expect(page.getByTestId("shopify-form-error")).toContainText("Admin API access token");
    await page.getByTestId("shopify-admin-token").fill("shpss_not-the-token");
    await page.getByTestId("shopify-save").click();
    await expect(page.getByTestId("shopify-form-error")).toContainText("API secret key");
    await page.getByTestId("shopify-admin-token").fill("mock-token-admin");
    await page.getByTestId("shopify-save").click();
    await expect(page.getByTestId("shopify-form-message")).toContainText("Saved");
    await expect(page.getByTestId("shopify-admin-token")).toHaveValue("");
    await page.getByTestId("shopify-test").click();
    await expect(page.getByTestId("shopify-test-result")).toContainText("Connected to Mock Store");
    const tokenSummary = await (await request.get(`${BASE}/api/settings/shopify`)).text();
    expect(tokenSummary).not.toContain("mock-token-admin");
    expect(JSON.parse(tokenSummary)).toMatchObject({ method: "token", hasAdminToken: true });

    // A wrong token is refused with a clear message.
    await page.getByTestId("shopify-admin-token").fill("wrong-token");
    await page.getByTestId("shopify-save").click();
    await page.getByTestId("shopify-test").click();
    await expect(page.getByTestId("shopify-form-error")).toContainText("Admin API access token");

    // After a reload the page opens on the saved way of connecting.
    await page.reload();
    await page.getByRole("button", { name: "Shopify", exact: true }).click();
    await expect(page.getByTestId("shopify-method-token")).toHaveAttribute("aria-pressed", "true");

    // Remove forgets everything.
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByTestId("shopify-remove").click();
    await expect(page.getByTestId("shopify-connection-state")).toHaveText("Not connected");
    const status = await (await request.get(`${BASE}/api/status`)).json();
    expect(status.shopifyMissing).toEqual(["Store domain", "Client ID", "Client secret"]);
  } finally {
    killApp(app);
  }
});

test.describe("Google Images through SerpAPI", () => {
  const serpEnv = { SERPAPI_KEY: "mock-serp-key", SERPAPI_BASE_URL_OVERRIDE: MOCK_URL };

  test("pictures come from Google Images, and no page is compared", async ({ request }) => {
    const app = await startApp("serp-images", PORT, serpEnv);
    try {
      const id = await createProduct(request, { name: "Steel Bottle" }, BASE);
      const result = await waitForStage(request, id, "review", BASE);
      const state = await mockState();

      expect(state.serp.length).toBeGreaterThan(0);
      expect(state.serp.every((call) => call.engine === "google_images" && call.apiKey === "mock-serp-key" && call.q === "Steel Bottle")).toBe(true);
      expect(state.searches).toEqual([]); // Bing is not used.
      expect(state.ai.filter((call) => call.task === "same_product")).toEqual([]); // No page was compared.

      // Pictures are kept without a watermark check. The tiny one and the Instagram one are still skipped.
      const sources: string[] = result.images.map((image: any) => String(image.source_url ?? ""));
      expect(result.images.filter((image: any) => image.passed).length).toBeGreaterThanOrEqual(3);
      expect(result.images.find((image: any) => image.source_url?.includes("watermark9")).passed).toBe(true);
      expect(state.ai.filter((call) => call.task === "check_image")).toEqual([]);
      expect(sources.some((url) => url.includes("tiny"))).toBe(false);
      expect(sources.some((url) => url.includes("insta"))).toBe(false);

      // A few pages were opened for their text only.
      const accepted = result.sources.filter((source: any) => source.status === "accepted");
      expect(accepted.length).toBeGreaterThan(0);
      expect(accepted.length).toBeLessThanOrEqual(5);
      expect(state.ai.find((call) => call.task === "write_listing")).toBeTruthy();
      expect(result.product.name).toBeTruthy();
    } finally {
      killApp(app);
    }
  });

  test("no Google Images results asks for page URLs", async ({ request }) => {
    const app = await startApp("serp-none", PORT, serpEnv);
    try {
      const id = await createProduct(request, { name: "noimages bottle" }, BASE);
      const blocked = await waitForStage(request, id, "blocked", BASE);
      expect(blocked.job.message).toContain("Google Images found no usable pictures");
      expect(blocked.job.message).toContain("Paste product page URLs");
    } finally {
      killApp(app);
    }
  });

  test("a wrong SerpAPI key gives a clear message", async ({ request }) => {
    const app = await startApp("serp-bad", PORT, { SERPAPI_KEY: "wrong-key", SERPAPI_BASE_URL_OVERRIDE: MOCK_URL });
    try {
      const id = await createProduct(request, { name: "Steel Bottle" }, BASE);
      const failed = await waitForStage(request, id, "failed", BASE);
      expect(failed.job.message).toContain("SERPAPI_API_KEY");
    } finally {
      killApp(app);
    }
  });
});

test.describe("Google Lens from the uploaded photo", () => {
  const lensEnv = { SERPAPI_KEY: "mock-serp-key", SERPAPI_BASE_URL_OVERRIDE: MOCK_URL, PUBLIC_BASE_URL: BASE };

  test("an uploaded photo is sent to Lens, and only the matching pictures are saved", async ({ request }) => {
    const app = await startApp("lens", PORT, lensEnv);
    try {
      const id = await createProduct(request, { file: IMAGE_FILE, details: "Stainless steel bottle, 750 ml, leak-proof, matte black." }, BASE);
      const result = await waitForStage(request, id, "review", BASE);
      const state = await mockState();

      // The photo file itself was uploaded. No public link is required.
      expect(state.lens).toHaveLength(1);
      expect(state.lens[0].imageId).toBe("mock-image-id");
      expect(state.lens[0].bytes).toBeGreaterThan(1000);

      // One Lens search. The pictures are saved and the product pages are not opened.
      expect(state.serp.map((call) => call.engine)).toEqual(["google_lens"]);
      const storeImages = result.images.filter((image: any) => !image.uploaded);
      expect(storeImages.every((image: any) => !image.source_page)).toBe(true);
      expect(storeImages.length).toBeGreaterThan(0);
      expect(storeImages.length).toBeLessThanOrEqual(20);
      expect(storeImages.filter((image: any) => image.passed).length).toBeGreaterThanOrEqual(2);

      // The store owner's details reached the writer as the main source.
      const writer = state.ai.find((call) => call.task === "write_listing")!;
      expect(writer.text).toContain("Stainless steel bottle, 750 ml, leak-proof, matte black.");
      expect(result.product.input_details).toBe("Stainless steel bottle, 750 ml, leak-proof, matte black.");
      expect(result.product.warnings.join(" ")).not.toContain("Lens");

      // A public tunnel does not expose the app. The photo search does not need one.
      const publicGet = (urlPath: string, headers: Record<string, string>) =>
        new Promise<{ status: number; type: string | undefined }>((resolve, reject) => {
          http.get({ host: "localhost", port: PORT, path: urlPath, headers }, (res) => {
            res.resume();
            res.on("end", () => resolve({ status: res.statusCode ?? 0, type: res.headers["content-type"] }));
          }).on("error", reject);
        });
      const tunnelHost = { host: "example.trycloudflare.com" };
      expect((await publicGet("/api/status", tunnelHost)).status).toBe(404);
      expect((await publicGet("/api/products", tunnelHost)).status).toBe(404);
      expect((await publicGet("/new", tunnelHost)).status).toBe(404);
      // A tunnel that rewrites the Host header is still recognised by the headers it adds.
      expect((await publicGet("/api/status", { host: `localhost:${PORT}`, "x-forwarded-for": "1.2.3.4" })).status).toBe(404);
      expect((await publicGet("/api/status", { host: `localhost:${PORT}`, "cf-connecting-ip": "1.2.3.4" })).status).toBe(404);
      expect((await publicGet("/api/status", { host: `localhost:${PORT}` })).status).toBe(200); // This computer is unaffected.
    } finally {
      killApp(app);
    }
  });

  test("without a public URL, the photo is still uploaded to Lens", async ({ request }) => {
    const app = await startApp("lens-off", PORT, { ...lensEnv, PUBLIC_BASE_URL: "" });
    try {
      const id = await createProduct(request, { file: IMAGE_FILE }, BASE);
      const result = await waitForStage(request, id, "review", BASE);
      const state = await mockState();
      expect(state.lens).toHaveLength(1);
      expect(state.serp.map((call) => call.engine)).toEqual(["google_lens"]);
      expect(result.product.warnings.join(" ")).not.toContain("PUBLIC_BASE_URL");
      expect(result.images.filter((image: any) => !image.uploaded && image.passed).length).toBeGreaterThanOrEqual(2);
    } finally {
      killApp(app);
    }
  });

  test("a dead public URL does not block the photo upload", async ({ request }) => {
    const app = await startApp("lens-down", PORT, { ...lensEnv, PUBLIC_BASE_URL: "http://127.0.0.1:4199" });
    try {
      const id = await createProduct(request, { file: IMAGE_FILE }, BASE);
      const result = await waitForStage(request, id, "review", BASE);
      const state = await mockState();
      expect(state.lens).toHaveLength(1);
      expect(state.serp.map((call) => call.engine)).toEqual(["google_lens"]);
      expect(result.product.warnings.join(" ")).not.toContain("could not be reached");
    } finally {
      killApp(app);
    }
  });
});

test.describe("OpenAI", () => {
  const openaiEnv = { AI_PROVIDER: "openai", AI_API_KEY: "", OPENAI_API_KEY: "mock-openai-key", OPENAI_BASE_URL_OVERRIDE: MOCK_URL, OPENAI_MODEL: "mock-gpt" };

  test("research reaches Review using only OpenAI", async ({ request }) => {
    const app = await startApp("openai", PORT, openaiEnv);
    try {
      expect(await (await request.get(`${BASE}/api/status`)).json()).toMatchObject({ ai: { ok: true, message: null } });
      const id = await createProduct(request, { file: IMAGE_FILE }, BASE);
      const result = await waitForStage(request, id, "review", BASE);
      const state = await mockState();
      expect(state.ai).toEqual([]); // Nothing went to the Claude API.
      expect(state.openai.every((call) => call.model === "mock-gpt" && call.strict)).toBe(true);
      expect(state.openai.find((call) => call.task === "analyze_product")!.images).toBe(1);
      expect(state.openai.some((call) => call.task === "write_listing")).toBe(true);
      expect(result.product.name).toBe("Steel Bottle Deluxe");
      expect(result.images.some((i: any) => i.passed)).toBe(true);
    } finally {
      killApp(app);
    }
  });

  test("a missing or wrong key gives a clear message", async ({ request }) => {
    const missing = await startApp("openai-missing", PORT, { ...openaiEnv, OPENAI_API_KEY: "" });
    try {
      const id = await createProduct(request, { name: "Steel Bottle" }, BASE);
      expect((await waitForStage(request, id, "failed", BASE)).job.message).toContain("OPENAI_API_KEY is missing");
    } finally {
      killApp(missing);
    }
    const wrong = await startApp("openai-wrong", PORT, { ...openaiEnv, OPENAI_API_KEY: "wrong" });
    try {
      const id = await createProduct(request, { name: "Steel Bottle" }, BASE);
      expect((await waitForStage(request, id, "failed", BASE)).job.message).toContain("rejected OPENAI_API_KEY");
    } finally {
      killApp(wrong);
    }
  });
});

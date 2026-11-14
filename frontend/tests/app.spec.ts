import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { MOCK_PORT, MOCK_URL } from "./mock/server";
import { APP_URL, IMAGE_FILE, TEST_DIR, VIDEO_FILE, createProduct, detail, mockReset, mockSet, mockState, toListing, waitForShopify, waitForStage } from "./helpers";

/** The same mock under a second host name, so it counts as a different website. */
const OTHER_SITE = `http://localhost:${MOCK_PORT}`;

test.beforeEach(async () => {
  await mockReset();
});

test.describe("the required tests", () => {
  test("1. name only: research reaches the Review tab", async ({ request }) => {
    const id = await createProduct(request, { name: "Steel Bottle Deluxe" });
    const result = await waitForStage(request, id, "review");
    const state = await mockState();

    expect(state.searches[0]).toBe("Steel Bottle Deluxe|1");
    // With only a name there is nothing to analyze, so no Vision identification runs.
    expect(state.ai.filter((call) => call.task === "analyze_product")).toHaveLength(0);

    // Blogs, social pages and duplicate links are removed.
    expect(state.pageHits["good-1"]).toBe(1);
    const dropped = result.sources.filter((s: any) => s.status === "rejected");
    expect(dropped.find((s: any) => s.url.includes("blog"))?.reason).toContain("Blog");
    expect(dropped.find((s: any) => s.url.includes("facebook"))?.reason).toContain("Social");
    expect(dropped.find((s: any) => s.url.includes("instagram"))?.reason).toContain("Social");

    // Robots.txt is respected: the disallowed page was never fetched.
    expect(state.forbiddenFetches).toEqual([]);
    expect(dropped.find((s: any) => s.url.includes("/private/"))?.reason).toContain("robots.txt");

    // Different products are dropped with a recorded reason.
    expect(dropped.find((s: any) => s.url.includes("different-1"))?.reason).toContain("Different product");

    // Seller comes from JSON-LD first.
    expect(result.product.seller_name).toBe("Shop GOOD-1");

    // Clean name, original text, marked claims, no ratings.
    expect(result.product.name).toBe("Steel Bottle Deluxe");
    expect(result.product.name_options).toContain("Insulated Steel Bottle");
    expect(result.product.description).toContain("BPA-free [needs checking]");
    expect(result.product.description).toContain("Microwave-safe [needs checking]");
    expect(result.product.description).not.toMatch(/stars|Rated/i);

    // Untrusted page content is saved as plain text.
    expect(result.product.source_text).not.toContain("<script");
    expect(result.product.source_text).not.toContain("<b>");
    expect(result.product.source_text).not.toContain("alert(");
    // Page text reaches the AI only inside the data delimiter.
    const sameCall = state.ai.find((call) => call.task === "same_product")!;
    expect(sameCall.text).toContain("<untrusted_page");
    expect(sameCall.betas).toContain("server-side-fallback-2026-07-01");

    // Images: code checks and Vision checks, with failures left visible with a reason.
    const images = result.images;
    const reasons = images.map((i: any) => i.reason).filter(Boolean).join(" | ");
    expect(reasons).toContain("Too small");
    expect(reasons).toContain("Duplicate");
    // Of the same picture at 900, 1000 and 1100 pixels, only the largest survives.
    const shared = images.filter((i: any) => /shared-/.test(i.source_url ?? ""));
    expect(shared.filter((i: any) => i.passed).map((i: any) => i.width)).toEqual([1100]);
    // Three thumbnails of one picture become one candidate, not three downloads.
    expect(images.filter((i: any) => /gallery1-/.test(i.source_url ?? ""))).toHaveLength(1);
    // Icons and logos are skipped, and robots-forbidden image URLs are never fetched.
    expect(images.some((i: any) => /logo/.test(i.source_url ?? ""))).toBe(false);
    expect(images.some((i: any) => /forbidden/.test(i.source_url ?? ""))).toBe(false);
    // The largest srcset entry was downloaded.
    expect(images.some((i: any) => i.source_url?.includes("c1-1400x1400"))).toBe(true);
    expect(images.some((i: any) => i.source_url?.includes("c1-500x500"))).toBe(false);
    // 5 to 10 best images preselected, and only passing ones.
    const selected = images.filter((i: any) => i.selected);
    expect(selected.length).toBeGreaterThanOrEqual(5);
    expect(selected.length).toBeLessThanOrEqual(10);
    expect(selected.every((i: any) => i.passed)).toBe(true);
    expect(result.product.low_images).toBe(false);
    for (const image of images.filter((i: any) => i.file_name)) {
      const file = await request.get(`/api/files/${id}/images/${image.file_name}`);
      expect(file.ok()).toBe(true);
    }

    // Videos: direct files are downloaded, while platform videos stay links.
    const videos = result.videos;
    expect(videos.find((v: any) => v.kind === "file")?.file_name).toBeTruthy();
    expect(videos.find((v: any) => v.provider === "youtube")?.url).toBe("https://www.youtube.com/watch?v=abc123XYZ");
    expect(videos.find((v: any) => v.provider === "youtube")?.file_name).toBeNull();
    expect(videos.find((v: any) => v.provider === "vimeo")?.url).toBe("https://vimeo.com/1234567");
    expect(state.ai.find((call) => call.task === "check_video")?.images).toBeGreaterThanOrEqual(2);
    expect(fs.readdirSync(path.join(TEST_DIR, "main", "storage", id, "images")).every((name) => !name.endsWith(".part"))).toBe(true);
    expect(result.job.status).toBe("DONE");
  });

  test("2. image only: research reaches the Review tab", async ({ request }) => {
    const id = await createProduct(request, { file: IMAGE_FILE });
    const result = await waitForStage(request, id, "review");
    const state = await mockState();

    const analysis = state.ai.find((call) => call.task === "analyze_product")!;
    expect(analysis.images).toBe(1);
    expect(result.product.vision.search_keywords[0]).toBe("steel water bottle");
    expect(result.product.vision.confidence).toBeCloseTo(0.91);
    expect(state.searches[0]).toBe("steel water bottle|1");
    // The uploaded image is the comparison reference for each page.
    expect(state.ai.find((call) => call.task === "same_product")!.images).toBeGreaterThanOrEqual(1);

    const own = result.images.find((i: any) => i.uploaded);
    expect(own.passed).toBe(true);
    expect(own.selected).toBe(true);
    expect(fs.existsSync(path.join(TEST_DIR, "main", "storage", id, "images", own.file_name))).toBe(true);
  });

  test("3. video only: frames are extracted and research reaches the Review tab", async ({ request }) => {
    const id = await createProduct(request, { file: VIDEO_FILE });
    const result = await waitForStage(request, id, "review");
    const state = await mockState();

    // Real ffmpeg frames were sent to Vision.
    const analysis = state.ai.find((call) => call.task === "analyze_product")!;
    expect(analysis.images).toBe(4);
    expect(result.product.vision.frames_analyzed).toBe(4);
    expect(result.job.log.some((entry: any) => entry.text.includes("Extracted 4 frames"))).toBe(true);
    expect(state.searches[0]).toBe("steel water bottle|1");

    const own = result.videos.find((v: any) => v.uploaded);
    expect(own.kind).toBe("file");
    expect(own.selected).toBe(true);
    expect(fs.existsSync(path.join(TEST_DIR, "main", "storage", id, "videos", own.file_name))).toBe(true);
  });

  test("4. a CAPTCHA gives BLOCKED, and pasted URLs still work", async ({ request, page }) => {
    const id = await createProduct(request, { name: "captcha bottle" });
    const blocked = await waitForStage(request, id, "blocked");
    expect(blocked.job.status).toBe("BLOCKED");
    expect(blocked.job.message).toContain("CAPTCHA");
    expect(blocked.job.message).toContain("Paste product page URLs");

    // A person sees the message and a place to paste URLs.
    await page.goto("/review");
    const card = page.locator('[data-testid="job"][data-status="BLOCKED"]').first();
    await card.locator("summary").click();
    await expect(card).toContainText("Paste product page URLs");
    await card.getByTestId("blocked-urls").fill(`${MOCK_URL}/p/good-1\n${MOCK_URL}/p/good-2`);
    await card.getByRole("button", { name: "Continue with these URLs" }).click();

    const result = await waitForStage(request, id, "review");
    // The same search is not retried, and the pasted pages were used.
    const state = await mockState();
    expect(state.searches).toEqual(["captcha bottle|1"]);
    expect(state.pageHits["good-1"]).toBe(1);
    expect(result.sources.filter((s: any) => s.status === "accepted").map((s: any) => s.url)).toEqual([`${MOCK_URL}/p/good-1`, `${MOCK_URL}/p/good-2`]);
  });

  test("4b. a blocked page is skipped, and research carries on with the other pages", async ({ request }) => {
    const id = await createProduct(request, { name: "Steel Bottle", urls: [`${OTHER_SITE}/captcha-page`] });
    const result = await waitForStage(request, id, "review");
    expect(result.job.status).toBe("DONE");

    const blocked = result.sources.find((s: any) => s.url.includes("captcha-page"));
    expect(blocked.status).toBe("rejected");
    expect(blocked.reason).toContain("Blocked");
    expect(result.sources.filter((s: any) => s.status === "accepted").length).toBeGreaterThan(0);
    // The user is told which site was left out.
    expect(result.product.warnings.join(" ")).toContain("localhost");
  });

  test("4c. BLOCKED when blocks leave no usable page, and the blocking site is not pushed", async ({ request }) => {
    const id = await createProduct(request, { name: "noresults bottle", urls: [`${MOCK_URL}/forbidden-403`, `${MOCK_URL}/p/good-1`] });
    const blocked = await waitForStage(request, id, "blocked");
    expect(blocked.job.status).toBe("BLOCKED");
    expect(blocked.job.message).toContain("403");
    expect(blocked.job.message).toContain("Paste product page URLs");
    // After the 403, the same site's other page is not opened.
    expect((await mockState()).pageHits["good-1"]).toBeUndefined();
    expect(blocked.sources.find((s: any) => s.url.includes("good-1")).reason).toContain("Skipped");

    // Pasted URLs still work, and the pages that were blocked are not tried again.
    await request.post(`/api/products/${id}/research`, { data: { urls: [`${MOCK_URL}/p/good-2`] } });
    const result = await waitForStage(request, id, "review");
    expect(result.sources.filter((s: any) => s.status === "accepted").map((s: any) => s.url)).toEqual([`${MOCK_URL}/p/good-2`]);
    expect(result.sources.some((s: any) => s.url.includes("forbidden-403"))).toBe(false);
  });

  test("4e. a 'Robot or human?' page answering HTTP 200 counts as a block, and uses no AI", async ({ request }) => {
    const id = await createProduct(request, { name: "noresults bottle", urls: [`${MOCK_URL}/robot-or-human`] });
    const blocked = await waitForStage(request, id, "blocked");
    expect(blocked.job.status).toBe("BLOCKED");
    expect(blocked.job.message).toContain("Paste product page URLs");
    expect((await mockState()).ai).toHaveLength(0);
  });

  test("4f. a blocked search with pasted URLs carries on and says so", async ({ request }) => {
    const id = await createProduct(request, { name: "captcha bottle", urls: [`${MOCK_URL}/p/good-1`] });
    const result = await waitForStage(request, id, "review");
    expect(result.sources.filter((s: any) => s.status === "accepted")).toHaveLength(1);
    expect(result.product.warnings.join(" ")).toContain("CAPTCHA");
    // A search that asked for a human check is not asked again on later tries.
    expect((await mockState()).searches).toEqual(["captcha bottle|1"]);
  });

  test("4g. a retry reuses the AI analysis of the upload instead of repeating it", async ({ request }) => {
    for (const [file, frames] of [[IMAGE_FILE, 1], [VIDEO_FILE, 4]] as const) {
      await mockReset();
      const id = await createProduct(request, { name: "captcha bottle", file });
      const blocked = await waitForStage(request, id, "blocked");
      expect(blocked.product.vision.product_type).toBe("steel water bottle");

      await request.post(`/api/products/${id}/research`, { data: { urls: [`${MOCK_URL}/p/good-1`] } });
      const result = await waitForStage(request, id, "review");
      const state = await mockState();

      const analyses = state.ai.filter((call) => call.task === "analyze_product");
      expect(analyses).toHaveLength(1);
      expect(analyses[0].images).toBe(frames);
      expect(result.job.log.some((entry: any) => entry.text.includes("Using the earlier analysis"))).toBe(true);
      expect(result.product.vision.product_type).toBe("steel water bottle");
      // Still compared against the upload, even though it was not analyzed again.
      expect(state.ai.filter((call) => call.task === "same_product").at(-1)!.images).toBeGreaterThanOrEqual(2);

      // The upload stays in the results exactly once. It is not sent to the photo checker.
      const own = [...result.images, ...result.videos].filter((item: any) => item.uploaded);
      expect(own).toHaveLength(1);
      expect(own[0].passed).toBe(true);
      expect(own[0].selected).toBe(true);
      expect(state.ai.filter((call) => call.task === "check_image" && call.text.includes("user%20upload"))).toHaveLength(0);
    }
  });

  test("4d. a page that no longer exists is dropped without using the AI", async ({ request }) => {
    const id = await createProduct(request, { name: "Steel Bottle", urls: [`${MOCK_URL}/gone-404`, `${MOCK_URL}/p/good-1`] });
    const result = await waitForStage(request, id, "review");
    expect(result.sources.find((s: any) => s.url.includes("gone-404")).reason).toContain("HTTP 404");
    expect((await mockState()).ai.some((call) => call.text.includes("gone-404"))).toBe(false);
  });

  test("5. Reject sends nothing to Shopify", async ({ request }) => {
    const id = await createProduct(request, { name: "Steel Bottle Deluxe" });
    await waitForStage(request, id, "review");
    expect((await request.post(`/api/products/${id}/reject`, { data: {} })).ok()).toBe(true);
    expect((await detail(request, id)).product.stage).toBe("rejected");

    const send = await request.post(`/api/products/${id}/send`, { data: {} });
    expect(send.status()).toBe(409);
    const state = await mockState();
    expect(state.oauthCalls).toHaveLength(0);
    expect(state.graphql).toHaveLength(0);
    expect(state.uploads).toHaveLength(0);
  });

  test("6. Approve to Listing keeps only the items I selected", async ({ request }) => {
    const id = await createProduct(request, { name: "Steel Bottle Deluxe" });
    const review = await waitForStage(request, id, "review");
    const passing = review.images.filter((i: any) => i.passed);
    const chosenImages = [passing[2].id, passing[0].id];
    const chosenVideo = review.videos.find((v: any) => v.provider === "youtube").id;

    const response = await request.post(`/api/products/${id}/approve`, {
      data: { name: "My Edited Name", description: "My edited text.", imageIds: chosenImages, videoIds: [chosenVideo] },
    });
    expect(response.ok()).toBe(true);

    const listing = await detail(request, id);
    expect(listing.product.stage).toBe("listing");
    expect(listing.product.name).toBe("My Edited Name");
    expect(listing.product.description).toBe("My edited text.");
    expect(listing.product.sku).toMatch(/^PRD-\d{4}$/);
    expect(listing.product.shopify_status).toBe("ready");
    expect(listing.images.filter((i: any) => i.selected).map((i: any) => i.id)).toEqual(chosenImages);
    expect(listing.videos.filter((v: any) => v.selected).map((v: any) => v.id)).toEqual([chosenVideo]);

    // A send uses that selection and nothing else.
    expect((await request.post(`/api/products/${id}/send`, { data: {} })).status()).toBe(202);
    await waitForShopify(request, id, "draft");
    const state = await mockState();
    expect(state.products).toHaveLength(1);
    expect(state.products[0].input.files.filter((f: any) => f.contentType === "IMAGE")).toHaveLength(2);
    expect(state.products[0].input.files.filter((f: any) => f.contentType === "VIDEO")).toHaveLength(0);
    expect(state.products[0].input.files.filter((f: any) => f.contentType === "EXTERNAL_VIDEO")).toHaveLength(1);
  });

  test("7. clicking the Shopify button twice creates only one product", async ({ request, page }) => {
    const listed = await toListing(request, { name: "Steel Bottle Deluxe" });
    const id = listed.product.id;
    await mockSet({ productSetDelayMs: 1500 });

    // Direct concurrent requests against the server's lock.
    const [a, b] = await Promise.all([
      request.post(`/api/products/${id}/send`, { data: {} }),
      request.post(`/api/products/${id}/send`, { data: {} }),
    ]);
    expect([a.status(), b.status()].sort()).toEqual([202, 409]);
    await waitForShopify(request, id, "draft");

    // Sending again after success creates nothing either.
    const again = await request.post(`/api/products/${id}/send`, { data: {} });
    expect(again.status()).toBe(409);
    expect(await again.text()).toContain("already exists");
    let state = await mockState();
    expect(state.products).toHaveLength(1);

    // A real double click in the UI on a second product.
    const second = await toListing(request, { name: "Steel Bottle Deluxe" });
    await page.goto("/listing");
    const card = page.locator(`[data-testid="listing-card"][data-product="${second.product.id}"]`);
    await card.locator("summary").click();
    await card.getByTestId("send-button").dblclick();
    await expect(card).toHaveCount(0, { timeout: 20_000 });
    await page.goto("/pushed");
    const pushed = page.locator(`[data-testid="listing-card"][data-product="${second.product.id}"]`);
    await expect(pushed.getByTestId("shopify-status")).toHaveText("Shopify Draft");
    state = await mockState();
    expect(state.products).toHaveLength(2);
    expect(state.graphql.filter((call) => call.name === "CreateDraftProduct")).toHaveLength(2);
  });

  test("8. a Shopify error is shown and Retry works", async ({ request, page }) => {
    const listed = await toListing(request, { name: "Steel Bottle Deluxe" });
    const id = listed.product.id;
    await mockSet({ failNext: "userError" });

    await page.goto("/listing");
    const card = page.locator(`[data-testid="listing-card"][data-product="${id}"]`);
    await card.locator("summary").click();
    await card.getByTestId("send-button").click();
    await expect(card.getByTestId("shopify-status")).toHaveText("Error");
    await expect(card.getByTestId("shopify-error")).toContainText("Title is not allowed");
    await expect(card.getByTestId("open-in-shopify")).toHaveCount(0);
    expect((await mockState()).products).toHaveLength(0);

    await card.getByTestId("retry-button").click();
    await expect(card).toHaveCount(0, { timeout: 20_000 });
    await page.goto("/pushed");
    const pushed = page.locator(`[data-testid="listing-card"][data-product="${id}"]`);
    await pushed.locator("summary").click();
    await expect(pushed.getByTestId("shopify-status")).toHaveText("Shopify Draft");
    await expect(pushed.getByTestId("open-in-shopify")).toHaveAttribute("href", /mock-store\.myshopify\.com\/admin\/products\/1000$/);
    expect((await mockState()).products).toHaveLength(1);
  });

  test("8b. if Shopify created the product but the response was lost, Retry does not duplicate it", async ({ request }) => {
    const listed = await toListing(request, { name: "Steel Bottle Deluxe" });
    const id = listed.product.id;
    await mockSet({ failNext: "http500AfterCreate" });

    await request.post(`/api/products/${id}/send`, { data: {} });
    const failed = await waitForShopify(request, id, "error");
    expect(failed.product.shopify_error).toContain("500");
    expect(failed.product.shopify_product_id).toBeNull();
    expect((await mockState()).products).toHaveLength(1);

    await request.post(`/api/products/${id}/send`, { data: {} });
    const done = await waitForShopify(request, id, "draft");
    const state = await mockState();
    expect(state.products).toHaveLength(1);
    expect(done.product.shopify_product_id).toBe(state.products[0].id);
    expect(done.product.shopify_warnings.join(" ")).toContain("earlier attempt");
  });

  test("8c. a throttled request is retried automatically", async ({ request }) => {
    const listed = await toListing(request, { name: "Steel Bottle Deluxe" });
    await mockSet({ failNext: "throttle" });
    await request.post(`/api/products/${listed.product.id}/send`, { data: {} });
    await waitForShopify(request, listed.product.id, "draft");
    expect((await mockState()).products).toHaveLength(1);
  });

  test("8d. media that fails in Shopify is reported without losing the draft", async ({ request }) => {
    const listed = await toListing(request, { name: "Steel Bottle Deluxe" });
    await mockSet({ mediaFails: true });
    await request.post(`/api/products/${listed.product.id}/send`, { data: {} });
    await waitForShopify(request, listed.product.id, "draft");
    await expect.poll(async () => (await detail(request, listed.product.id)).product.shopify_warnings.join(" ")).toContain("Could not process");
  });

  test("9. the product arrives as DRAFT with the correct images, videos, price, SKU and cost", async ({ request }) => {
    const id = await createProduct(request, { name: "Steel Bottle Deluxe", file: IMAGE_FILE });
    const review = await waitForStage(request, id, "review");
    const imageIds = review.images.filter((i: any) => i.selected).map((i: any) => i.id);
    const fileVideo = review.videos.find((v: any) => v.kind === "file" && v.file_name);
    const youtube = review.videos.find((v: any) => v.provider === "youtube");
    const vimeo = review.videos.find((v: any) => v.provider === "vimeo");
    await request.post(`/api/products/${id}/approve`, {
      data: { name: "Steel Bottle", description: review.product.description, imageIds, videoIds: [fileVideo.id, youtube.id, vimeo.id] },
    });

    // Reorder and edit on the Listing tab.
    const reordered = [...imageIds].reverse();
    const patch = await request.patch(`/api/products/${id}`, {
      data: { name: "Steel Bottle 750ml", sku: "BOTTLE-750", price: "24.99", cost: "9.50", description: "Great bottle.\n- <b>Steel</b> body\n- Screw lid", imageIds: reordered, videoIds: [youtube.id, fileVideo.id, vimeo.id] },
    });
    expect(patch.status(), await patch.text()).toBe(200);

    expect((await request.post(`/api/products/${id}/send`, { data: {} })).status()).toBe(202);
    const done = await waitForShopify(request, id, "draft");
    const state = await mockState();

    expect(state.products).toHaveLength(1);
    const input = state.products[0].input;
    expect(input.status).toBe("DRAFT");
    expect(input.title).toBe("Steel Bottle 750ml");
    // No seller name can reach the vendor field.
    expect(input).not.toHaveProperty("vendor");
    expect(JSON.stringify(input)).not.toContain("Shop GOOD");
    // Description is escaped HTML.
    expect(input.descriptionHtml).toBe("<p>Great bottle.</p><ul><li>&lt;b&gt;Steel&lt;/b&gt; body</li><li>Screw lid</li></ul>");
    const variant = input.variants[0];
    expect(variant.price).toBe("24.99");
    expect(variant.sku).toBe("BOTTLE-750");
    expect(variant.inventoryItem.cost).toBe("9.50");

    // Local files went through staged uploads, with the file last in the form.
    const staged = state.graphql.find((call) => call.name === "StagedUploads")!;
    expect(staged.variables.input).toHaveLength(imageIds.length + 1);
    expect(staged.variables.input.every((item: any) => item.httpMethod === "POST" && Number(item.fileSize) > 0)).toBe(true);
    expect(staged.variables.input.at(-1).resource).toBe("VIDEO");
    expect(staged.variables.input.at(-1).mimeType).toBe("video/mp4");
    expect(state.uploads).toHaveLength(imageIds.length + 1);
    expect(state.uploads.every((upload) => upload.key && upload.size > 0 && upload.keyBeforeFile)).toBe(true);
    expect(state.uploads.at(-1)!.size).toBe(fs.statSync(VIDEO_FILE).size);

    // Everything is attached, in the chosen image order.
    const types = input.files.map((f: any) => f.contentType);
    expect(types).toEqual([...imageIds.map(() => "IMAGE"), "VIDEO", "EXTERNAL_VIDEO", "EXTERNAL_VIDEO"]);
    const firstUpload = staged.variables.input[0].filename;
    const reorderedFirst = review.images.find((i: any) => i.id === reordered[0]).file_name;
    expect(firstUpload).toBe(reorderedFirst);
    expect(input.files[0].originalSource).toContain(firstUpload);
    const external = input.files.filter((f: any) => f.contentType === "EXTERNAL_VIDEO").map((f: any) => f.originalSource);
    expect(external).toEqual(["https://www.youtube.com/watch?v=abc123XYZ", "https://vimeo.com/1234567"]);

    expect(done.product.shopify_admin_url).toBe("https://mock-store.myshopify.com/admin/products/1000");
    // The token is reused between calls.
    expect(new Set(state.graphql.map((call) => call.token)).size).toBe(1);

    const laterEdit = await request.patch(`/api/products/${id}`, { data: { name: "Steel Bottle Updated" } });
    expect(laterEdit.status()).toBe(409);
    expect(await laterEdit.text()).toContain("already in Shopify");
  });

  test("9b. an empty selling price warns and creates the draft at 0.00", async ({ request, page }) => {
    const listed = await toListing(request, { name: "Steel Bottle Deluxe" });
    const id = listed.product.id;
    await page.goto("/listing");
    const card = page.locator(`[data-testid="listing-card"][data-product="${id}"]`);
    await card.locator("summary").click();
    await expect(card.getByTestId("price-warning")).toContainText("0.00");
    await card.getByTestId("send-button").click();
    await expect(card).toHaveCount(0, { timeout: 20_000 });
    await page.goto("/pushed");
    await expect(page.locator(`[data-testid="listing-card"][data-product="${id}"]`).getByTestId("shopify-status")).toHaveText("Shopify Draft");
    const state = await mockState();
    expect(state.products[0].input.variants[0].price).toBe("0.00");
    expect(state.products[0].input.variants[0]).not.toHaveProperty("inventoryItem");
    expect((await detail(request, id)).product.shopify_warnings.join(" ")).toContain("0.00");
  });
});

test.describe("research details", () => {
  test("fewer than 5 passing images searches more pages, up to 3 tries, then warns", async ({ request }) => {
    const id = await createProduct(request, { name: "lowimg bottle" });
    const result = await waitForStage(request, id, "review");
    const state = await mockState();
    // The first search plus 3 more.
    expect(state.searches).toEqual(["lowimg bottle|1", "lowimg bottle|11", "lowimg bottle|21", "lowimg bottle|31"]);
    expect(result.product.low_images).toBe(true);
    expect(result.images.filter((i: any) => i.passed).length).toBeLessThan(5);
  });

  test("Search Again reruns the research with a clean slate", async ({ request }) => {
    const id = await createProduct(request, { name: "Steel Bottle Deluxe" });
    const first = await waitForStage(request, id, "review");
    const firstFiles = first.images.map((i: any) => i.file_name);
    expect((await request.post(`/api/products/${id}/research`, { data: {} })).status()).toBe(202);
    await expect.poll(async () => (await detail(request, id)).job.status, { timeout: 90_000 }).toBe("DONE");
    const second = await detail(request, id);
    expect(second.product.stage).toBe("review");
    expect(second.images.length).toBe(first.images.length);
    expect(second.images.map((i: any) => i.file_name)).not.toEqual(firstFiles);
    const onDisk = fs.readdirSync(path.join(TEST_DIR, "main", "storage", id, "images"));
    expect(onDisk.length).toBe(second.images.filter((i: any) => i.file_name).length);
  });

  test("input is validated", async ({ request }) => {
    const empty = await request.post("/api/products", { multipart: { name: "  ", urls: "" } });
    expect(empty.status()).toBe(400);
    expect(await empty.text()).toContain("product name");

    const badUrl = await request.post("/api/products", { multipart: { name: "x", urls: "javascript:alert(1)" } });
    expect(badUrl.status()).toBe(400);

    const notImage = await request.post("/api/products", {
      multipart: { name: "x", urls: "", file: { name: "fake.jpg", mimeType: "image/jpeg", buffer: Buffer.from("not an image") } },
    });
    expect(notImage.status()).toBe(400);

    const notMedia = await request.post("/api/products", {
      multipart: { name: "x", urls: "", file: { name: "a.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") } },
    });
    expect(notMedia.status()).toBe(400);
  });

  test("requests from other websites are refused, and files stay in storage", async ({ request }) => {
    const evil = await request.post(`/api/products`, { headers: { origin: "https://evil.example" }, multipart: { name: "x", urls: "" } });
    expect(evil.status()).toBe(403);
    const crossSite = await request.post(`/api/products/abc/send`, { headers: { "sec-fetch-site": "cross-site" }, data: {} });
    expect(crossSite.status()).toBe(403);

    for (const attempt of ["..%2F..%2Fapp.db", "..%5C..%5Cpackage.json", "x%00.jpg"]) {
      const response = await request.get(`${APP_URL}/api/files/abc/images/${attempt}`);
      expect(response.status(), attempt).toBe(404);
    }
    const status = await (await request.get("/api/status")).text();
    expect(status).not.toContain("mock-secret");
    expect(status).not.toContain("mock-key");
  });
});

test.describe("the screens", () => {
  test("full walk through all three tabs", async ({ page, request }) => {
    await page.goto("/new");
    await expect(page).toHaveURL(/\/new$/);
    await expect(page.getByRole("button", { name: "Start research" })).toBeDisabled();
    await page.getByLabel("Product name").fill("Steel Bottle Deluxe");
    await page.getByRole("button", { name: "Start research" }).click();
    await page.getByRole("link", { name: "Review listings" }).click();

    // Live status updates without a reload.
    const job = page.getByTestId("job").first();
    await expect(job).toContainText("Steel Bottle Deluxe");
    await expect(job).toHaveAttribute("data-status", "DONE", { timeout: 90_000 });
    await page.screenshot({ path: path.join(TEST_DIR, "screen-new.png"), fullPage: true });
    await job.locator("summary").click();

    await expect(page).toHaveURL(/\/review$/);
    const card = page.getByTestId("review-card").last();
    await expect(card.getByTestId("review-name")).toHaveValue("Steel Bottle Deluxe");
    await expect(card).toContainText("Needs checking");
    await expect(card.getByTestId("image-tile").first()).toBeVisible();
    await expect(card.getByTestId("video-row").filter({ hasText: "youtube" }).first()).toBeVisible();

    // Name options fill the field. Polling must not undo the edits.
    await card.getByRole("button", { name: "Insulated Steel Bottle" }).click();
    await expect(card.getByTestId("review-name")).toHaveValue("Insulated Steel Bottle");
    await page.waitForTimeout(3500);
    await expect(card.getByTestId("review-name")).toHaveValue("Insulated Steel Bottle");

    const productId = await card.getAttribute("data-product");
    const before = await detail(request, productId!);
    const preselected = before.images.filter((i: any) => i.selected).length;
    await card.getByTestId("image-tile").filter({ has: page.locator("input:checked") }).first().locator("input").uncheck();
    await card.getByTestId("video-row").filter({ hasText: "youtube" }).first().locator("input").check();
    await page.screenshot({ path: path.join(TEST_DIR, "screen-review.png"), fullPage: true });
    await card.getByRole("button", { name: "Approve to Listing" }).click();
    await expect(page.locator(`[data-testid="review-card"][data-product="${productId}"]`)).toHaveCount(0);

    await page.getByRole("link", { name: "Approved" }).click();
    const listing = page.locator(`[data-testid="listing-card"][data-product="${productId}"]`);
    await listing.locator("summary").click();
    await expect(listing.getByTestId("listing-name")).toHaveValue("Insulated Steel Bottle");
    await expect(listing.getByTestId("listing-sku")).toHaveValue(/^PRD-\d{4}$/);
    await expect(listing.getByTestId("shopify-status")).toHaveText("Ready");
    await expect(listing.getByTestId("listing-image")).toHaveCount(preselected - 1);
    await expect(listing.getByTestId("price-warning")).toBeVisible();

    // Image order can be changed.
    const firstId = await listing.getByTestId("listing-image").first().getAttribute("data-id");
    await listing.getByRole("button", { name: "Move image 1 later" }).click();
    await expect(listing.getByTestId("listing-image").nth(1)).toHaveAttribute("data-id", firstId!);

    // Invalid price gives a clear error and sends nothing.
    await listing.getByTestId("listing-price").fill("abc");
    await listing.getByTestId("send-button").click();
    await expect(listing.getByTestId("listing-error")).toContainText("Selling price");
    expect((await mockState()).products).toHaveLength(0);

    await listing.getByTestId("listing-price").fill("19.99");
    await listing.getByTestId("listing-cost").fill("7.50");
    await expect(listing.getByTestId("price-warning")).toHaveCount(0);
    await page.screenshot({ path: path.join(TEST_DIR, "screen-listing.png"), fullPage: true });
    await listing.getByTestId("send-button").click();
    await expect(listing).toHaveCount(0, { timeout: 20_000 });

    await page.getByRole("link", { name: "Pushed to Shopify" }).click();
    const pushed = page.locator(`[data-testid="listing-card"][data-product="${productId}"]`);
    await expect(pushed.getByTestId("shopify-status")).toHaveText("Shopify Draft");
    await pushed.locator("summary").click();
    await expect(pushed.getByTestId("open-in-shopify")).toBeVisible();
    await expect(pushed.locator("input, textarea")).toHaveCount(0);
    await expect(pushed.getByTestId("send-button")).toHaveCount(0);
    await page.screenshot({ path: path.join(TEST_DIR, "screen-draft.png"), fullPage: true });

    const state = await mockState();
    expect(state.products).toHaveLength(1);
    expect(state.products[0].input.status).toBe("DRAFT");
    expect(state.products[0].input.variants[0].price).toBe("19.99");
    expect(state.products[0].input.variants[0].inventoryItem.cost).toBe("7.50");
    expect(state.products[0].input.files.some((f: any) => f.contentType === "EXTERNAL_VIDEO")).toBe(true);
    const sent = (await detail(request, productId!)).images.filter((i: any) => i.selected)[0].id;
    expect(sent).not.toBe(firstId);
  });
});

/** Puts the Bundle page back as the one that is set, so the next test starts from the same place. */
async function restoreBundlePage(request: import("@playwright/test").APIRequestContext) {
  await request.post("/api/templates/saamano/push", { data: {} });
  await request.post("/api/templates/saamano/use", { data: {} });
}

test.describe("the Template page", () => {
  test("adds only the product page to the live theme and links to a preview of it", async ({ page }) => {
    await mockSet({ scopes: ["write_products", "write_inventory", "write_themes"] });
    const before = (await mockState()).themes[0].files;
    await page.goto("/template");
    const card = page.getByTestId("template-saamano");
    await expect(card).toContainText("3 files");

    let question = "";
    page.once("dialog", (dialog) => {
      question = dialog.message();
      void dialog.accept();
    });
    await card.getByTestId("template-push").click();
    const result = card.getByTestId("template-push-result");
    await expect(result).toContainText("Set up in your store", { timeout: 60_000 });
    expect(question).toContain("do not change");
    await expect(result.getByRole("link", { name: "Preview page" })).toHaveAttribute("href", "https://mock-store.myshopify.com/products/steel-bottle?view=fynk-autolisting-product");
    await expect(result.getByRole("link", { name: "Theme editor" })).toHaveAttribute("href", "https://mock-store.myshopify.com/admin/themes/1/editor");
    await page.screenshot({ path: path.join(TEST_DIR, "screen-template.png"), fullPage: true });

    // Still one theme, with every file it had, plus the three new ones.
    const themes = (await mockState()).themes;
    expect(themes).toHaveLength(1);
    for (const [filename, checksum] of Object.entries(before)) expect(themes[0].files[filename]).toBe(checksum);
    expect(Object.keys(themes[0].files).filter((filename) => filename.includes("fynk-")).sort()).toEqual([
      "assets/fynk-autolisting-product.css",
      "sections/fynk-autolisting-product.liquid",
      "templates/product.fynk-autolisting-product.json",
    ]);

    // After a reload the page still links to it.
    await page.reload();
    await expect(card.getByTestId("template-last-push")).toContainText("Set up in your store");

    // Cancelling the question sends nothing.
    const uploads = (await mockState()).themeUploads.length;
    page.once("dialog", (dialog) => void dialog.dismiss());
    await card.getByTestId("template-push").click();
    expect((await mockState()).themeUploads).toHaveLength(uploads);

    // Without the theme permission the page says what to add.
    await mockSet({ scopes: ["write_products", "write_inventory"] });
    page.once("dialog", (dialog) => void dialog.accept());
    await card.getByTestId("template-push").click();
    await expect(card.getByTestId("template-push-error")).toContainText("write_themes");
    expect((await mockState()).themeUploads).toHaveLength(uploads);
  });
});

test.describe("the Template page preview", () => {
  test("shows the design with a sample product before any push, and asks the AI for nothing", async ({ page }) => {
    const aiCalls = (await mockState()).ai.length;
    await page.goto("/template");
    await page.getByTestId("template-saamano").getByTestId("template-preview").click();

    const preview = page.getByTestId("saamano-preview");
    await expect(preview).toContainText("A sample product.");
    await expect(preview.getByTestId("preview-title")).toHaveText("Smart LED Temperature Display Travel Mug");
    await expect(preview.getByTestId("preview-main-image")).toHaveAttribute("src", "/template-preview/product-1.jpg");
    await expect(preview.getByTestId("preview-features").locator(".sf-card")).toHaveCount(4);
    // The saved text of this product has no Top Features, so the section is left out.
    await expect(preview.getByTestId("preview-top-features")).toHaveCount(0);
    await expect(preview.getByTestId("preview-compare").locator("tbody tr")).toHaveCount(4);
    await expect(preview.getByTestId("preview-faq")).toContainText("Can I pay cash on delivery?");
    await expect(preview.getByTestId("preview-related").locator(".sp-card")).toHaveCount(4);
    // Sample text is fixed, so there is nothing to write again.
    await expect(preview.getByTestId("preview-write-again")).toHaveCount(0);
    await page.screenshot({ path: path.join(TEST_DIR, "screen-template-preview.png") });

    await preview.getByTestId("preview-close").click();
    await expect(preview).toHaveCount(0);
    expect((await mockState()).ai.length).toBe(aiCalls);
  });
});

test.describe("the Classic product page", () => {
  test("shows every section of the page in its preview, and a push adds only its seven new files", async ({ page, request }) => {
    await mockSet({ scopes: ["write_products", "write_inventory", "write_themes"] });
    const before = (await mockState()).themes[0].files;
    await page.goto("/template");
    const card = page.getByTestId("template-classic");
    await expect(card).toContainText("Classic product page");
    await expect(card).toContainText("7 files");

    await card.getByTestId("template-preview").click();
    const frame = page.getByTestId("rendered-preview").frameLocator("iframe");
    // Every part of the page, filled from the sample product's own text and photos.
    // The Classic page shows the Balaclava Hood listing; the Saamano preview shows the travel mug.
    await expect(frame.locator(".au-hero h1")).toHaveText("3-in-1 Fleece Balaclava Hood");
    await expect(frame.locator(".au-gallery img")).toHaveAttribute("src", "/template-preview/hood-1.jpg");
    await expect(frame.locator(".au-tier")).toHaveCount(0);
    await expect(frame.locator(".au-checks li")).toHaveCount(3);
    await expect(frame.locator(".au-tabs button")).toHaveCount(2);
    await expect(frame.locator(".au-why h2")).toHaveText("Combined Design");
    await expect(frame.locator(".au-why details")).toHaveCount(4);
    await expect(frame.locator(".au-stats div")).toHaveCount(3);
    await expect(frame.locator(".au-ing li")).toHaveCount(3);
    await expect(frame.locator(".au-steps article")).toHaveCount(3);
    await expect(frame.locator(".au-faq details")).toHaveCount(4);
    // The quantity buttons work, and the Shipping tab opens.
    await frame.locator("[data-au-plus]").click();
    await expect(frame.locator("[data-au-qty]")).toHaveText("2");
    await frame.locator('[data-au-tab="ship"]').click();
    await expect(frame.locator('[data-au-panel="ship"]')).toBeVisible();
    await page.keyboard.press("Escape");

    // Another page is set now. This one offers "Use this page", and using it makes it the only one set.
    const bundle = page.getByTestId("template-saamano");
    await expect(card.getByTestId("template-push")).toHaveText("Use this page");
    await expect(card.getByTestId("template-last-push")).toHaveCount(0);
    page.once("dialog", (dialog) => void dialog.accept());
    await card.getByTestId("template-push").click();
    await expect(card.getByTestId("template-push-result")).toContainText("Set up in your store", { timeout: 60_000 });
    await expect(card.getByTestId("template-in-use")).toBeVisible();
    await expect(card.getByTestId("template-push")).toHaveText("Update in my store");
    await expect(bundle.getByTestId("template-in-use")).toHaveCount(0);
    await expect(bundle.getByTestId("template-last-push")).toHaveCount(0);
    await expect(bundle.getByTestId("template-push")).toHaveText("Use this page");
    const theme = (await mockState()).themes[0];
    for (const [filename, checksum] of Object.entries(before)) expect(theme.files[filename]).toBe(checksum);
    expect(Object.keys(theme.files).filter((filename) => filename.includes("fynk-classic")).sort()).toEqual([
      "sections/fynk-classic-faq.liquid",
      "sections/fynk-classic-features.liquid",
      "sections/fynk-classic-hero.liquid",
      "sections/fynk-classic-special.liquid",
      "sections/fynk-classic-stats.liquid",
      "sections/fynk-classic-steps.liquid",
      "templates/product.fynk-classic-product.json",
    ]);
    await restoreBundlePage(request);
  });
});

test.describe("the page new products get", () => {
  test("is the one page that is set: using another page replaces it for new products", async ({ page, request }) => {
    await mockSet({ scopes: ["write_products", "write_inventory", "write_themes"] });
    await restoreBundlePage(request);
    await page.goto("/template");
    const bundle = page.getByTestId("template-saamano");
    const classic = page.getByTestId("template-classic");
    await expect(bundle.getByTestId("template-in-use")).toBeVisible();
    await expect(classic.getByTestId("template-in-use")).toHaveCount(0);
    await expect(classic.getByTestId("template-push")).toHaveText("Use this page");
    try {
      page.once("dialog", (dialog) => void dialog.accept());
      await classic.getByTestId("template-push").click();
      await expect(classic.getByTestId("template-in-use")).toBeVisible({ timeout: 60_000 });
      await expect(bundle.getByTestId("template-in-use")).toHaveCount(0);
      const flags = (await (await request.get("/api/templates")).json()).templates.map((item: { id: string; useForNew: boolean }) => [item.id, item.useForNew]);
      expect(flags).toEqual([["saamano", false], ["classic", true]]);

      // A product pushed now gets the Classic page. Using the Bundle page again changes the next one.
      const first = await toListing(request, { name: "Steel Bottle Classic" });
      expect((await request.post(`/api/products/${first.product.id}/send`, { data: {} })).status()).toBe(202);
      await waitForShopify(request, first.product.id, "draft");
      expect((await mockState()).products.at(-1)!.input.templateSuffix).toBe("fynk-classic-product");

      page.once("dialog", (dialog) => void dialog.accept());
      await bundle.getByTestId("template-push").click();
      await expect(bundle.getByTestId("template-in-use")).toBeVisible({ timeout: 60_000 });
      await expect(classic.getByTestId("template-in-use")).toHaveCount(0);
      const second = await toListing(request, { name: "Steel Bottle Bundle" });
      expect((await request.post(`/api/products/${second.product.id}/send`, { data: {} })).status()).toBe(202);
      await waitForShopify(request, second.product.id, "draft");
      expect((await mockState()).products.at(-1)!.input.templateSuffix).toBe("fynk-autolisting-product");
    } finally {
      await restoreBundlePage(request);
    }
  });
});

test.describe("a review that moved to History", () => {
  test("can still be approved from the Review page", async ({ page, request }) => {
    const first = await createProduct(request, { name: "Steel Bottle First" });
    await waitForStage(request, first, "review");
    // A newer product finishing research moves the earlier review to History.
    const second = await createProduct(request, { name: "Steel Bottle Second" });
    await waitForStage(request, second, "review");
    expect((await detail(request, first)).product.stage).toBe("history");

    await page.goto("/review");
    const row = page.locator(`[data-testid="job"][data-product="${first}"]`);
    await row.locator("summary").click();
    await expect(row.getByRole("button", { name: "Reject" })).toBeVisible();
    await expect(row.getByRole("button", { name: "Search Again" })).toBeVisible();
    await row.getByRole("button", { name: "Approve to Listing" }).click();
    await expect.poll(async () => (await detail(request, first)).product.stage).toBe("listing");
  });
});

test.describe("the Template cards", () => {
  test("the picture scrolls down the whole page while the pointer is over it, and slides back after", async ({ page }) => {
    await page.goto("/template");
    for (const id of ["saamano", "classic"]) {
      const card = page.getByTestId(`template-${id}`);
      const image = card.locator(".hs-image");
      await expect.poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      const offset = () => card.locator(".hs-content").evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).m42);
      expect(Math.abs(await offset())).toBeLessThan(1);
      await card.locator(".tpl-thumb").hover();
      await expect.poll(offset, { timeout: 8_000 }).toBeLessThan(-20);
      await page.mouse.move(2, 2);
      await expect.poll(async () => Math.abs(await offset()), { timeout: 8_000 }).toBeLessThan(1);
    }
  });
});

test.describe("the Saamano preview", () => {
  test("shows the listing in every section, with AI comparison and FAQ written once", async ({ page, request }) => {
    const listed = await toListing(request, { name: "Steel Bottle Deluxe" });
    const id = listed.product.id;
    // Approving wrote the page text once, in the background. The preview reuses it.
    await expect.poll(() => mockState().then((state) => state.ai.filter((call) => call.task === "write_product_story").length)).toBe(1);
    await page.goto("/listing");
    const card = page.locator(`[data-testid="listing-card"][data-product="${id}"]`);
    await card.locator("summary").click();
    await card.getByTestId("listing-price").fill("2000");
    await card.getByTestId("preview-button").click();

    const preview = page.getByTestId("saamano-preview");
    await expect(preview.getByTestId("preview-title")).toHaveText(await card.getByTestId("listing-name").inputValue());
    await expect(preview.getByTestId("preview-main")).toContainText("Rs 2,000"); // the unsaved price
    const photos = await card.getByTestId("listing-image").count();
    expect(photos).toBeGreaterThan(0);
    // One large photo. With more than one, a thumbnail for each, and a click shows it large.
    const mainImage = preview.getByTestId("preview-main-image");
    await expect(mainImage).toBeVisible();
    if (photos > 1) {
      // At most 6 thumbnails at once, in a column left of the large photo.
      const thumbs = preview.locator(".sp-thumb");
      await expect(thumbs).toHaveCount(Math.min(photos, 6));
      const thumbBox = (await thumbs.first().boundingBox())!;
      const mainBox = (await mainImage.boundingBox())!;
      expect(thumbBox.x + thumbBox.width).toBeLessThanOrEqual(mainBox.x);
      const second = await thumbs.nth(1).locator("img").getAttribute("src");
      await thumbs.nth(1).click();
      await expect(mainImage).toHaveAttribute("src", second!);
      if (photos > 6) {
        await preview.getByRole("button", { name: "More photos" }).click();
        await expect(preview.getByRole("button", { name: "Earlier photos" })).toBeEnabled();
        await expect(thumbs).toHaveCount(6);
      }
    }
    console.log(`photos in this listing: ${photos}`);
    // Add to cart sits under the bundle cards. Buy 2 is picked first: 2 × 2,000 less 20%.
    await expect(preview.getByTestId("preview-qty")).toHaveText("2");
    await expect(preview.locator(".so-card.is-selected")).toContainText("Rs 3,200");
    await expect(preview.getByTestId("preview-add-to-cart")).toHaveText("Add to cart");
    await preview.getByRole("button", { name: "One more" }).click();
    await expect(preview.locator(".so-card.is-selected")).toContainText("Buy 3");
    await expect(preview.locator(".so-card.is-selected")).toContainText("Rs 4,500");
    // The store's own header and footer stay; the preview only marks where they go.
    await expect(preview.getByTestId("preview-store-header")).toContainText("Your store's own header");
    await preview.getByRole("button", { name: "One less" }).click();
    await page.screenshot({ path: path.join(TEST_DIR, "screen-preview-top.png") });
    await expect(preview.getByTestId("preview-bundle").locator("img")).toHaveCount(6);

    const features = preview.getByTestId("preview-features");
    await expect(features).toContainText("Tough & Practical");
    await expect(features.locator(".sf-card")).toHaveCount(4);
    await expect(features.locator(".sf-card img")).toHaveCount(4);
    const next = features.getByRole("button", { name: "Next" });
    await expect(next).toBeEnabled();
    await next.click();
    await expect(features.getByRole("button", { name: "Previous" })).toBeEnabled();
    await features.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(TEST_DIR, "screen-preview-features.png") });

    // Top Features: 4 AI cards, two each side of the third photo (the main photo with fewer).
    const topFeatures = preview.getByTestId("preview-top-features");
    await expect(topFeatures).toContainText("Top Features");
    await expect(topFeatures).toContainText("Made to keep every drink just right.");
    await expect(topFeatures.locator(".stf-card")).toHaveCount(4);
    await expect(topFeatures.locator(".stf-col").first().locator(".stf-card")).toHaveCount(2);
    await expect(topFeatures.locator(".stf-img")).toHaveCount(1);
    await topFeatures.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(TEST_DIR, "screen-preview-top-features.png") });

    await expect(preview.getByTestId("preview-compare")).toContainText("Leak-resistant cap");
    // Order in the story: feature cards, then About this product, then Top Features, then the highlights.
    const top = async (id: string) => (await preview.getByTestId(id).boundingBox())!.y;
    expect(await top("preview-features")).toBeLessThan(await top("preview-about"));
    expect(await top("preview-about")).toBeLessThan(await top("preview-top-features"));
    if (await preview.getByTestId("preview-highlights").count()) expect(await top("preview-top-features")).toBeLessThan(await top("preview-highlights"));
    const compare = preview.getByTestId("preview-compare");
    await expect(compare).toContainText("Why Choose Us?");
    await expect(compare).toContainText("keeps drinks cold and your bag dry"); // the AI paragraph
    await expect(compare.locator("thead .sw-us img")).toHaveCount(1);
    await expect(compare.locator("tbody tr")).toHaveCount(4);
    await expect(compare.locator(".sw-yes")).toHaveCount(4);
    await compare.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(TEST_DIR, "screen-preview-compare.png") });
    const faq = preview.getByTestId("preview-faq");
    await expect(faq).toContainText("Can I pay cash on delivery?");
    // The FAQ sits in the middle of the page.
    const faqBox = (await faq.boundingBox())!;
    const pageBox = (await preview.locator(".sp-header").boundingBox())!;
    expect(Math.abs(faqBox.x + faqBox.width / 2 - (pageBox.x + pageBox.width / 2))).toBeLessThan(4);
    // The card it opens from must not style it: no extra arrow before each question.
    const marker = await faq.locator("summary").first().evaluate((el) => getComputedStyle(el, "::before").content);
    expect(["none", "normal"]).toContain(marker);
    await faq.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(TEST_DIR, "screen-preview-faq.png") });
    await page.screenshot({ path: path.join(TEST_DIR, "screen-preview.png"), fullPage: false });
    const writes = () => mockState().then((state) => state.ai.filter((call) => call.task === "write_product_story").length);
    expect(await writes()).toBe(1);

    // Opening it again reuses the saved text. "Write again" asks the AI once more.
    await page.keyboard.press("Escape");
    await expect(preview).toHaveCount(0);
    await card.getByTestId("preview-button").click();
    await expect(preview.getByTestId("preview-faq")).toBeVisible();
    expect(await writes()).toBe(1);
    await preview.getByTestId("preview-write-again").click();
    await expect.poll(writes).toBe(2);
    await expect(preview.getByTestId("preview-faq")).toBeVisible();
  });
});

test.describe("the Saamano page text on Shopify", () => {
  test("approving writes it once, and the push sends it with the photos as saamano metafields", async ({ request }) => {
    const id = await createProduct(request, { name: "Steel Bottle Deluxe" });
    const reviewed = await waitForStage(request, id, "review");
    const approve = await request.post(`/api/products/${id}/approve`, {
      data: {
        name: reviewed.product.name,
        description: `${reviewed.product.description}\n- Leak-resistant cap: Keeps your bag dry`,
        imageIds: reviewed.images.filter((image: any) => image.selected).map((image: any) => image.id),
        videoIds: [],
      },
    });
    expect(approve.status(), await approve.text()).toBe(200);
    const storyWrites = () => mockState().then((state) => state.ai.filter((call) => call.task === "write_product_story").length);
    await expect.poll(storyWrites).toBe(1);

    expect((await request.post(`/api/products/${id}/send`, { data: {} })).status()).toBe(202);
    const sent = await waitForShopify(request, id, "draft");
    expect(sent.product.shopify_warnings.join(" ")).not.toContain("page text");
    expect(await storyWrites()).toBe(1); // The push reused the text written at approval.

    const input = (await mockState()).products.at(-1)!.input;
    expect(input.files.filter((file: any) => file.contentType === "IMAGE").length).toBeGreaterThan(0);
    const field = (key: string) => input.metafields.find((m: any) => m.namespace === "saamano" && m.key === key);
    // The product uses the Saamano page that the Template page adds. Other products keep theirs.
    expect(input.templateSuffix).toBe("fynk-autolisting-product");
    expect(input.metafields.map((m: any) => m.key).sort()).toEqual(["compare", "compare_intro", "faq", "feature_heading", "feature_subheading", "features", "highlights", "top_features", "top_features_subheading"]);
    expect(JSON.parse(field("top_features").value)).toEqual(["Cold for Hours|Double walls hold the chill.", "Dry Bag|A sealed cap stops spills.", "Daily Steel|Strong enough for every trip.", "Bag Friendly|Slim body fits most bags."]);
    expect(field("top_features_subheading")).toMatchObject({ type: "single_line_text_field", value: "Made to keep every drink just right." });
    expect(field("feature_heading")).toMatchObject({ type: "single_line_text_field", value: "Tough & Practical" });
    expect(JSON.parse(field("features").value)).toContain("No Leaks|The leak-resistant cap keeps your bag dry.");
    expect(field("compare_intro").type).toBe("multi_line_text_field");
    expect(JSON.parse(field("compare").value)).toHaveLength(4);
    expect(JSON.parse(field("faq").value)[0]).toBe("Can I pay cash on delivery?|Yes. You pay when the order reaches your door.");
    expect(field("highlights").type).toBe("list.single_line_text_field");
    expect(JSON.parse(field("highlights").value)).toContain("Leak-resistant cap|Keeps your bag dry");
  });
});

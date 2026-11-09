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
    await expect(card).toContainText("may be copyrighted");
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

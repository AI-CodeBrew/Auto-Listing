import fs from "node:fs";
import * as ai from "../ai";
import { aiLimits, config, LIMITS } from "../config";
import { DUPLICATE_DISTANCE, downloadImage, forVision, hammingDistance, inspectImageFile } from "../media/images";
import { downloadVideo, extractFrames } from "../media/videos";
import * as repo from "../repo";
import { getSearchProvider } from "../search";
import { lensSearch, searchImages, type ImageHit } from "../search/serpapi";
import { publicPhotoUrl } from "../settings";
import { clearResearchFiles, ensureDirs, mediaPath } from "../storage";
import { chooseBestImages, findCopiedPhrases, finalizeListing } from "./text";
import type { Job, Product, ProductImage, VisionResult } from "../types";
import { openPage, withPage } from "../web/browser";
import { BlockedError, SearchDisallowedError } from "../web/errors";
import { extractPage, type PageData } from "../web/extract";
import { isAllowedByRobots, politeWait } from "../web/robots";
import { classifyVideo, domainOf, exclusionReason, filterProductUrls, normalizeUrl } from "../web/urls";

/** Stops the job with BLOCKED and a message for the user. */
export class JobBlocked extends Error {
  constructor(
    message: string,
    public readonly blockedUrls: string[],
  ) {
    super(message);
  }
}

interface RunState {
  job: Job;
  product: Product;
  reference: ai.VisionImage[];
  vision: VisionResult | null;
  seenPages: Set<string>;
  seenMedia: Set<string>;
  accepted: PageData[];
  videoDownloads: number;
  aiChecks: number;
  warnings: string[];
  searchUnavailable: boolean;
  /** Set when the search engine itself showed a CAPTCHA or bot check. */
  searchBlock: string | null;
  blockedPages: { url: string; reason: string }[];
  /** Google Images results that were looked at, by image URL. */
  searchHits: Map<string, ImageHit>;
}

const PASTE_URLS_MESSAGE = "Paste product page URLs below to continue without searching.";

export async function runResearch(job: Job): Promise<void> {
  let product = repo.getProduct(job.product_id);
  if (!product) throw new Error("Product no longer exists");
  const step = (text: string) => repo.setJobStep(job.id, text);

  await ai.aiPreflight();

  // Web results start clean each run, so a job resumed after a restart cannot double them up.
  repo.resetResearch(product.id);
  repo.updateProduct(product.id, { stage: "researching" });
  clearResearchFiles(product.id, [product.input_image, product.input_video].filter((f): f is string => Boolean(f)));
  ensureDirs(product.id);
  product = repo.getProduct(product.id)!;

  const state: RunState = {
    job,
    product,
    reference: [],
    vision: null,
    seenPages: new Set(product.blocked_urls.map(normalizeUrl)),
    seenMedia: new Set(),
    accepted: [],
    videoDownloads: 0,
    aiChecks: 0,
    warnings: [],
    searchUnavailable: job.skip_search,
    searchBlock: null,
    blockedPages: [],
    searchHits: new Map(),
  };

  await prepareInputs(state, step);
  const keywords = keywordsFor(state);
  const query = keywords.join(" ").trim();

  // With a SerpAPI key, images come straight from Google Images and only a few pages are
  // opened, for their text. Without one, pages are searched, opened and compared.
  const imageMode = Boolean(config.serpApiKey()) && !job.skip_search && Boolean(query);

  if (imageMode) {
    await runImageSearch(state, query, step);
  } else {
    let tries = 0;
    const maxTries = 1 + LIMITS.extraSearchTries;
    while (tries < maxTries) {
      tries++;
      step(tries === 1 ? `Finding product pages for "${query}"` : `Fewer than ${LIMITS.targetImages} images passed. Searching more pages (try ${tries - 1} of ${LIMITS.extraSearchTries})`);
      const urls = await nextPageUrls(state, query, tries);
      if (!urls.length) break; // Nothing new to visit, so more tries would not help.
      await visitPages(state, urls, step);
      if (passedImageCount(product.id) >= LIMITS.targetImages) break;
      if (state.searchUnavailable) break; // No further source of pages.
    }
  }

  // Blocks only stop the job when they leave nothing to work with.
  if (!imageMode && !state.accepted.length && (state.blockedPages.length || state.searchBlock)) {
    const parts = [state.searchBlock, state.blockedPages.length && `${describeBlockedSites(state)} showed a CAPTCHA or bot block.`].filter(Boolean);
    throw new JobBlocked(`${parts.join(" ")} ${PASTE_URLS_MESSAGE}`, state.blockedPages.map((page) => page.url));
  }
  if (state.searchBlock) state.warnings.push(`${state.searchBlock} The search stopped there, so only pages found before that and your pasted URLs were used.`);
  if (state.blockedPages.length) state.warnings.push(`These sites blocked automated access, so their pages were skipped: ${describeBlockedSites(state)}.`);

  const passed = passedImageCount(product.id);
  const lowImages = passed < LIMITS.targetImages;
  if (!imageMode && !state.accepted.length) state.warnings.push("No matching product pages were found. Check the text carefully, or use Search Again with pasted URLs.");

  step("Writing the product name and description");
  const text = await writeText(state);

  // Preselect the best images in ranked order.
  const images = repo.listImages(product.id);
  const best = chooseBestImages(images, LIMITS.maxPreselectedImages);
  const others = images.filter((image) => !best.includes(image.id)).map((image) => image.id);
  repo.rankImages(product.id, [...best, ...others], best);

  repo.updateProduct(product.id, {
    stage: "review",
    name: text.name,
    name_options: text.nameOptions,
    description: text.description,
    claims: text.claims,
    source_text: state.accepted.map((page) => `From ${page.seller} (${page.url}):\n${page.text}`).join("\n\n---\n\n") || null,
    seller_name: state.accepted[0]?.seller ?? null,
    low_images: lowImages,
    warnings: state.warnings,
    vision: state.vision,
  });
}

/** Limits for image mode. Each image checked is one AI call, so these keep the cost down. */
const IMAGE_SEARCH_PAGES = 2;
const IMAGE_CHECKS_PER_SEARCH_PAGE = 25;
const IMAGE_SEARCH_STOP_AT = 8;
const TEXT_PAGES_TO_TRY = 5;

/** Finds pictures like the user's uploaded photo with Google Lens. Returns nothing, with a warning, if that is not possible. */
async function lensMatches(state: RunState, step: (text: string) => void): Promise<ImageHit[]> {
  const { product } = state;
  if (!product.input_image) return [];

  const url = publicPhotoUrl(product.id);
  if (!url) {
    state.warnings.push("Google Lens was not used, because PUBLIC_BASE_URL is not set in .env. The pictures come from a normal Google Images search instead. See the README, section \"Google Lens\".");
    return [];
  }

  // Check the link before spending a SerpAPI search on it.
  step("Checking that Google can reach your photo");
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const type = response.headers.get("content-type") ?? "";
    await response.body?.cancel();
    if (!response.ok || !type.startsWith("image/")) throw new Error(`HTTP ${response.status}`);
  } catch {
    state.warnings.push(`Google Lens was not used, because your photo could not be reached at ${config.publicBaseUrl()}. Is the tunnel running, and does PUBLIC_BASE_URL match it? The pictures come from a normal Google Images search instead.`);
    return [];
  }

  step("Finding similar pictures with Google Lens");
  const hits = await lensSearch(url);
  if (!hits.length) state.warnings.push("Google Lens found no similar pictures. The pictures come from a normal Google Images search instead.");
  return hits;
}

/** Downloads and checks pictures from search results, best first, until enough have passed. */
async function checkHits(state: RunState, hits: ImageHit[], step: (text: string) => void): Promise<void> {
  const { product } = state;
  let tried = 0;
  for (const hit of hits) {
    if (tried >= IMAGE_CHECKS_PER_SEARCH_PAGE || passedImageCount(product.id) >= IMAGE_SEARCH_STOP_AT) break;
    const page = hit.pageUrl || hit.original;
    if (state.seenMedia.has(hit.original) || exclusionReason(page)) continue; // Social media and blog pages are skipped.
    if (hit.width && hit.height && (hit.width < LIMITS.imageMinSide || hit.height < LIMITS.imageMinSide)) continue;
    state.searchHits.set(hit.original, hit);
    tried++;
    step(`Checking image ${tried} (${safeDomain(page)})`);
    await processImage(state, [hit.original], page);
  }
}

/**
 * Image mode: Google Lens (for an uploaded photo) and Google Images, both through SerpAPI, give the pictures. The AI checks each one
 * (clear, right product, no watermark). The pages of the best pictures are then opened,
 * only to read their text, which the AI uses to write the name and description.
 */
async function runImageSearch(state: RunState, query: string, step: (text: string) => void): Promise<void> {
  const { product } = state;

  // Pages the user pasted are still compared and used first.
  const pasted = filterProductUrls(product.input_urls, state.seenPages);
  for (const item of pasted.dropped) repo.addSource(product.id, { url: item.url, status: "rejected", reason: item.reason });
  if (pasted.keep.length) await visitPages(state, pasted.keep.slice(0, LIMITS.pagesPerTry), step);

  // The best source: pictures that look like the user's photo (Google Lens).
  const lens = await lensMatches(state, step);
  if (lens.length) await checkHits(state, lens, step);

  // A plain Google Images search fills the gap, or does all the work when Lens was not possible.
  const pages = lens.length ? 1 : IMAGE_SEARCH_PAGES;
  for (let pageIndex = 0; pageIndex < pages && passedImageCount(product.id) < LIMITS.targetImages; pageIndex++) {
    step(
      pageIndex === 0 && !lens.length
        ? `Searching Google Images for "${query}"`
        : `Fewer than ${LIMITS.targetImages} images passed. Searching Google Images for "${query}" (page ${pageIndex + 1})`,
    );
    const hits = await searchImages(query, pageIndex);
    if (!hits.length) break;
    await checkHits(state, hits, step);
  }

  if (!state.searchHits.size && !state.accepted.length) {
    throw new JobBlocked(`Google Images found no usable pictures for "${query}". ${PASTE_URLS_MESSAGE}`, []);
  }

  // Text for the description: the pages of the best pictures, opened without comparing them.
  const bestPages = repo
    .listImages(product.id)
    .filter((image) => image.passed && !image.uploaded && image.source_page)
    .sort((a, b) => (b.checks.quality ?? 0) - (a.checks.quality ?? 0))
    .map((image) => image.source_page!);
  const toRead = filterProductUrls([...new Set(bestPages)], state.seenPages).keep.slice(0, TEXT_PAGES_TO_TRY);
  if (toRead.length) await visitPages(state, toRead, step, { verify: false });

  if (state.blockedPages.length && !state.accepted.length) {
    // Blocked pages are not fatal here, since the pictures are already in hand.
    state.warnings.push(`These sites blocked automated access, so their pages could not be read: ${describeBlockedSites(state)}.`);
  }
  if (!state.accepted.length) {
    state.warnings.push("No product page could be read, so the text is based on your photo, your product name and titles from Google Images. Check it carefully, or use Search Again with pasted URLs.");
  }
}

function describeBlockedSites(state: RunState): string {
  const sites = new Map<string, string>();
  for (const { url, reason } of state.blockedPages) {
    if (!sites.has(safeDomain(url))) sites.set(safeDomain(url), reason);
  }
  return [...sites].map(([site, reason]) => `${site} (${reason})`).join(", ");
}

function passedImageCount(productId: string): number {
  return repo.listImages(productId).filter((image) => image.passed).length;
}

function keywordsFor(state: RunState): string[] {
  const name = state.product.input_name;
  if (state.vision) {
    const words = state.vision.search_keywords.slice(0, 1);
    return name ? [name] : words.length ? words : [state.vision.product_type];
  }
  return name ? [name] : [];
}

/**
 * Step 1: analyze the uploaded image or video frames and register the user's own files.
 * Each result is saved as soon as it exists, so a retry or restart never repeats that AI work.
 */
async function prepareInputs(state: RunState, step: (text: string) => void): Promise<void> {
  const { product } = state;
  state.vision = product.vision;

  if (product.input_image) {
    const file = mediaPath(product.id, "images", product.input_image);
    state.reference = [{ data: await forVision(file) }];
    if (state.vision) {
      step("Using the earlier analysis of your image");
    } else {
      step("Analyzing your image");
      state.vision = await ai.analyzeProductImages(state.reference, product.input_name);
      repo.updateProduct(product.id, { vision: state.vision });
    }
    await checkUploadedImage(state, product.input_image);
  }

  if (product.input_video) {
    step("Extracting frames from your video");
    const file = mediaPath(product.id, "videos", product.input_video);
    const frames = await extractFrames(file);
    if (!frames.length) throw new Error("No frames could be read from the uploaded video. Try an MP4, MOV or WEBM file.");
    state.reference = await Promise.all(frames.map(async (frame) => ({ data: await forVision(frame) })));
    if (state.vision) {
      step("Using the earlier analysis of your video");
    } else {
      step(`Extracted ${frames.length} frames. Analyzing them`);
      state.vision = { ...(await ai.analyzeProductImages(state.reference, product.input_name)), frames_analyzed: frames.length };
      repo.updateProduct(product.id, { vision: state.vision });
    }
    if (!repo.listVideos(product.id).some((video) => video.uploaded)) {
      repo.addVideo({
        product_id: product.id,
        kind: "file",
        provider: null,
        url: null,
        file_name: product.input_video,
        source_page: null,
        bytes: fs.statSync(file).size,
        passed: true,
        reason: null,
        selected: true,
        uploaded: true,
      });
    }
  }
}

/** Checks the user's own image once. Later runs keep the result from the first check. */
async function checkUploadedImage(state: RunState, fileName: string): Promise<void> {
  const { product } = state;
  const existing = repo.listImages(product.id).find((image) => image.uploaded);
  if (existing && (existing.checks.aiChecked || existing.reason)) return;

  const info = await inspectImageFile(product.id, fileName);
  const tooSmall = info.width < LIMITS.imageMinSide || info.height < LIMITS.imageMinSide;
  const row =
    existing ??
    repo.addImage({
      product_id: product.id,
      file_name: fileName,
      source_url: null,
      source_page: null,
      width: info.width,
      height: info.height,
      bytes: info.bytes,
      phash: info.phash,
      passed: false,
      reason: null,
      checks: { minSize: !tooSmall, duplicate: false, aiChecked: false },
      uploaded: true,
    });
  if (tooSmall) {
    repo.updateImageCheck(row.id, false, `Too small: ${info.width}x${info.height} (minimum ${LIMITS.imageMinSide}x${LIMITS.imageMinSide})`, row.checks);
  } else {
    await aiCheckImage(state, row);
  }
}

/** Steps 2 and 3: gets the next batch of candidate pages. */
async function nextPageUrls(state: RunState, query: string, tryNumber: number): Promise<string[]> {
  const candidates: string[] = tryNumber === 1 ? [...state.product.input_urls] : [];

  if (!state.searchUnavailable && query) {
    const provider = getSearchProvider();
    try {
      candidates.push(...(await provider.search(query, (tryNumber - 1) * 10)));
    } catch (error) {
      if (error instanceof BlockedError) {
        // Not retried: a search that asked for a human check would only ask again.
        state.searchUnavailable = true;
        state.searchBlock = `${provider.name} showed a CAPTCHA or bot check (${error.message}).`;
      } else if (error instanceof SearchDisallowedError) {
        state.searchUnavailable = true;
        if (!candidates.length) {
          throw new JobBlocked(`${provider.name}'s robots.txt does not allow automated search, so no search was run. ${PASTE_URLS_MESSAGE}`, []);
        }
        state.warnings.push(`${provider.name} search was skipped because its robots.txt does not allow automated search. Only your pasted URLs were used.`);
      } else {
        throw error;
      }
    }
  }

  const { keep, dropped } = filterProductUrls(candidates, state.seenPages);
  for (const item of dropped) {
    repo.addSource(state.product.id, { url: item.url, status: "rejected", reason: item.reason });
  }
  return keep.slice(0, LIMITS.pagesPerTry);
}

/** Steps 4 to 8 for each page, one page at a time. */
async function visitPages(state: RunState, urls: string[], step: (text: string) => void, options: { verify: boolean } = { verify: true }): Promise<void> {
  const { product } = state;
  for (const [index, url] of urls.entries()) {
    const label = `page ${index + 1} of ${urls.length} (${safeDomain(url)})`;
    step(`Opening ${label}`);

    // Going back to a site that just refused us would be pushing against its block.
    const earlierBlock = state.blockedPages.find((page) => safeDomain(page.url) === safeDomain(url));
    if (earlierBlock) {
      state.blockedPages.push({ url, reason: earlierBlock.reason });
      repo.addSource(product.id, { url, status: "rejected", reason: `Skipped: this site blocked an earlier page (${earlierBlock.reason})` });
      continue;
    }

    if (!(await isAllowedByRobots(url))) {
      repo.addSource(product.id, { url, status: "rejected", reason: "robots.txt does not allow automated access" });
      continue;
    }
    await politeWait(url);

    let data: PageData;
    try {
      data = await withPage(async (page) => {
        const response = await openPage(page, url);
        // An error page has no product on it, so do not spend AI time on it.
        if (response && response.status() >= 400) throw new Error(`the site answered HTTP ${response.status()}`);
        return extractPage(page);
      });
    } catch (error) {
      if (error instanceof BlockedError) {
        state.blockedPages.push({ url, reason: error.message });
        repo.addSource(product.id, { url, status: "rejected", reason: `Blocked: ${error.message}` });
      } else {
        repo.addSource(product.id, { url, status: "rejected", reason: `Could not open the page: ${shortError(error)}` });
      }
      continue;
    }

    if (options.verify) {
      step(`Comparing ${label} with your product`);
      const verdict = await ai.compareSameProduct({
        reference: state.reference,
        name: product.input_name,
        page: { url: data.url, title: data.title, seller: data.seller, text: data.text },
        screenshot: data.screenshot ? await forVision(data.screenshot) : null,
      });
      if (!verdict.same_product) {
        repo.addSource(product.id, { url, title: data.title, seller: data.seller, status: "rejected", reason: `Different product: ${verdict.reason}`, text: data.text });
        continue;
      }
      repo.addSource(product.id, { url, title: data.title, seller: data.seller, status: "accepted", reason: verdict.reason, text: data.text });
    } else {
      repo.addSource(product.id, { url, title: data.title, seller: data.seller, status: "accepted", reason: "A picture from this page passed the checks", text: data.text });
    }
    state.accepted.push(data);

    // In text-only mode the pictures already came from Google Images.
    if (options.verify) {
      step(`Downloading images from ${label}`);
      await collectImages(state, data);
    }
    step(`Checking videos from ${label}`);
    await collectVideos(state, data);
  }
}

/** Steps 6 and 7. */
async function collectImages(state: RunState, page: PageData): Promise<void> {
  for (const candidate of page.images) await processImage(state, candidate.urls, page.url);
}

/**
 * Downloads one picture (the first of these URLs that works), runs the code checks, then the AI check.
 */
async function processImage(state: RunState, candidateUrls: string[], sourcePage: string): Promise<void> {
  const productId = state.product.id;
  const urls: string[] = [];
  for (const url of candidateUrls) {
    if (state.seenMedia.has(url)) continue;
    if (await isAllowedByRobots(url).catch(() => false)) urls.push(url);
  }
  if (!urls.length) return;
  urls.forEach((url) => state.seenMedia.add(url));

  await politeWait(urls[0], Math.min(500, config.requestDelayMs()));
  const downloaded = await downloadImage(productId, urls);
  if (downloaded.status === "skip") return;
  if (downloaded.status === "too-large") {
    repo.addImage({
      product_id: productId, file_name: null, source_url: urls[0], source_page: sourcePage, width: null, height: null, bytes: null,
      phash: null, passed: false, reason: downloaded.message, checks: { minSize: false, duplicate: false, aiChecked: false }, uploaded: false,
    });
    return;
  }

  const { fileName, width, height, bytes, phash, finalUrl } = downloaded;
  const row = repo.addImage({
    product_id: productId, file_name: fileName, source_url: finalUrl, source_page: sourcePage, width, height, bytes, phash,
    passed: false, reason: null, checks: { minSize: false, duplicate: false, aiChecked: false }, uploaded: false,
  });

  // Code checks: minimum size and perceptual duplicates.
  const minSize = width >= LIMITS.imageMinSide && height >= LIMITS.imageMinSide;
  if (!minSize) {
    repo.updateImageCheck(row.id, false, `Too small: ${width}x${height} (minimum ${LIMITS.imageMinSide}x${LIMITS.imageMinSide})`, { ...row.checks, minSize: false });
    return;
  }
  // Copies already marked as duplicates are out of the running, so only live ones count.
  const twins = repo
    .listImages(productId)
    .filter((other) => other.id !== row.id && other.phash && other.file_name && other.checks.minSize && !other.checks.duplicate && hammingDistance(other.phash, phash) <= DUPLICATE_DISTANCE);
  const area = width * height;
  if (twins.some((twin) => twin.uploaded || (twin.width ?? 0) * (twin.height ?? 0) >= area)) {
    repo.updateImageCheck(row.id, false, `Duplicate of another image`, { ...row.checks, minSize: true, duplicate: true });
    return;
  }
  // This is the largest copy of the picture, so it replaces the others.
  for (const twin of twins) {
    repo.updateImageCheck(twin.id, false, `Duplicate of a larger image`, { ...twin.checks, duplicate: true });
  }
  await aiCheckImage(state, { ...row, checks: { ...row.checks, minSize: true } });
}

/** Vision AI checks for one image that already passed the code checks. */
async function aiCheckImage(state: RunState, row: ProductImage): Promise<void> {
  const passedSoFar = passedImageCount(state.product.id);
  const limits = aiLimits();
  if (state.aiChecks >= limits.maxImagesToAiCheck || passedSoFar >= limits.stopCheckingAfterPasses) {
    repo.updateImageCheck(row.id, false, "Not checked: enough images were already found", { ...row.checks, minSize: true });
    return;
  }
  state.aiChecks++;
  const file = mediaPath(state.product.id, "images", row.file_name!);
  const result = await ai.checkImage({
    image: { data: await forVision(file) },
    // The user's own upload is the reference, so it is not compared with itself.
    reference: row.uploaded ? [] : state.reference,
    name: state.product.input_name,
    productType: state.vision?.product_type ?? null,
    sourceUrl: row.source_url ?? "user upload",
  });
  const correct = row.uploaded ? true : result.correct_product;
  const failures = [
    !result.clear && "not clear",
    !correct && "wrong product",
    !result.no_watermark && "has a watermark",
    !result.no_other_brand_logo && "shows another brand's logo",
  ].filter(Boolean);
  const passed = failures.length === 0;
  repo.updateImageCheck(row.id, passed, passed ? null : [failures.join(", "), result.reason].filter(Boolean).join(": "), {
    ...row.checks,
    minSize: true,
    aiChecked: true,
    clear: result.clear,
    correctProduct: correct,
    noWatermark: result.no_watermark,
    noOtherBrandLogo: result.no_other_brand_logo,
    quality: result.quality,
    note: result.reason || undefined,
  });
}

/** Step 8. */
async function collectVideos(state: RunState, page: PageData): Promise<void> {
  const productId = state.product.id;
  for (const url of page.videos) {
    const video = classifyVideo(url);
    if (!video) continue;
    const key = video.url;
    if (state.seenMedia.has(key)) continue;
    state.seenMedia.add(key);

    if (video.kind === "link") {
      const attachable = video.provider === "youtube" || video.provider === "vimeo";
      repo.addVideo({
        product_id: productId, kind: "link", provider: video.provider, url: video.url, file_name: null, source_page: page.url, bytes: null,
        passed: true, reason: attachable ? null : "Link only. Shopify can attach YouTube and Vimeo links, not this one.", selected: false, uploaded: false,
      });
      continue;
    }

    const base = { product_id: productId, kind: "file" as const, provider: null, url: video.url, source_page: page.url, uploaded: false };
    if (state.videoDownloads >= LIMITS.maxVideoDownloads) {
      repo.addVideo({ ...base, file_name: null, bytes: null, passed: false, reason: `Not downloaded: limit of ${LIMITS.maxVideoDownloads} videos per product reached`, selected: false });
      continue;
    }
    if (!(await isAllowedByRobots(video.url).catch(() => false))) {
      repo.addVideo({ ...base, file_name: null, bytes: null, passed: false, reason: "robots.txt does not allow downloading this file", selected: false });
      continue;
    }
    state.videoDownloads++;
    await politeWait(video.url, Math.min(500, config.requestDelayMs()));
    const downloaded = await downloadVideo(productId, video.url);
    if (downloaded.status === "failed") {
      repo.addVideo({ ...base, file_name: null, bytes: null, passed: false, reason: downloaded.reason, selected: false });
      continue;
    }
    const frames = await extractFrames(mediaPath(productId, "videos", downloaded.fileName));
    if (!frames.length) {
      repo.addVideo({ ...base, file_name: downloaded.fileName, bytes: downloaded.bytes, passed: false, reason: "No frames could be read from this video", selected: false });
      continue;
    }
    const check = await ai.checkVideoFrames({
      frames: await Promise.all(frames.map(async (frame) => ({ data: await forVision(frame) }))),
      reference: state.reference,
      name: state.product.input_name,
      productType: state.vision?.product_type ?? null,
      sourceUrl: video.url,
    });
    const failures = [!check.correct_product && "wrong product", !check.clear && "not clear", !check.no_other_brand_logo && "shows another brand's logo"].filter(Boolean);
    const passed = failures.length === 0;
    repo.addVideo({
      ...base, file_name: downloaded.fileName, bytes: downloaded.bytes, passed,
      reason: passed ? null : [failures.join(", "), check.reason].filter(Boolean).join(": "), selected: passed,
    });
  }
}

/** Step 9. */
async function writeText(state: RunState) {
  const { product, accepted, vision } = state;
  const sellers = [...new Set(accepted.flatMap((page) => [page.seller, safeDomain(page.url)]))].filter(Boolean);
  const pages = accepted.slice(0, LIMITS.pagesPerTry).map((page) => ({ url: page.url, title: page.title, seller: page.seller, text: page.text }));

  // Google Images titles of the pictures that passed. They are short but describe the product.
  const visited = new Set(accepted.map((page) => page.url));
  const passedPages = new Set(repo.listImages(product.id).filter((image) => image.passed && image.source_page).map((image) => image.source_page!));
  const titled = [...state.searchHits.values()].filter((hit) => hit.title && hit.pageUrl && passedPages.has(hit.pageUrl) && !visited.has(hit.pageUrl));
  for (const hit of titled.slice(0, 5)) {
    pages.push({ url: hit.pageUrl, title: hit.title, seller: hit.source, text: hit.title });
    sellers.push(hit.source, safeDomain(hit.pageUrl));
  }
  const sourceTexts = accepted.map((page) => page.text);
  const request = { name: product.input_name, details: product.input_details, vision, sellersToRemove: sellers, pages };

  let draft = await ai.writeListing(request);
  const fullText = (d: ai.ListingDraft) => [d.description, ...d.feature_bullets].join(" ");
  let copied = findCopiedPhrases(fullText(draft), sourceTexts);
  if (copied.length) {
    draft = await ai.writeListing({ ...request, avoidPhrases: copied });
    copied = findCopiedPhrases(fullText(draft), sourceTexts);
    if (copied.length) {
      state.warnings.push(`The description still repeats wording from a source, for example: "${copied[0]}". Please reword it.`);
    }
  }
  return finalizeListing(draft, sellers, product.input_name ?? vision?.product_type ?? "Untitled product");
}

function safeDomain(url: string): string {
  try {
    return domainOf(url);
  } catch {
    return url;
  }
}

function shortError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n")[0].slice(0, 200);
}

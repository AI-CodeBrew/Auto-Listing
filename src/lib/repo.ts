import { randomUUID } from "node:crypto";
import { db } from "./db";
import { EMPTY_USAGE, normalizeUsage } from "./costs";
import type {
  ImageChecks,
  Job,
  JobStatus,
  Product,
  ProductImage,
  ProductStage,
  ProductVideo,
  RequestUsage,
  ShopifyStatus,
  Source,
  SourceStatus,
  VisionResult,
} from "./types";

const now = () => new Date().toISOString();
type Row = Record<string, unknown>;

function parse<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toProduct(row: Row): Product {
  return {
    ...(row as unknown as Product),
    input_urls: parse(row.input_urls, []),
    input_images: (() => {
      const names = parse<string[]>(row.input_images, []);
      return names.length ? names : row.input_image ? [String(row.input_image)] : [];
    })(),
    blocked_urls: parse(row.blocked_urls, []),
    vision: parse<VisionResult | null>(row.vision, null),
    name_options: parse(row.name_options, []),
    claims: parse(row.claims, []),
    warnings: parse(row.warnings, []),
    shopify_warnings: parse(row.shopify_warnings, []),
    low_images: Boolean(row.low_images),
    search_photos: row.search_photos === undefined ? true : Boolean(row.search_photos),
    search_videos: row.search_videos === undefined ? true : Boolean(row.search_videos),
  };
}
function toJob(row: Row): Job {
  return {
    ...(row as unknown as Job),
    log: parse(row.log, []),
    skip_search: Boolean(row.skip_search),
    usage: normalizeUsage(parse<Partial<RequestUsage>>(row.usage, {})),
  };
}
function toImage(row: Row): ProductImage {
  return {
    ...(row as unknown as ProductImage),
    checks: parse<ImageChecks>(row.checks, { minSize: false, duplicate: false, aiChecked: false }),
    passed: Boolean(row.passed),
    selected: Boolean(row.selected),
    uploaded: Boolean(row.uploaded),
  };
}
function toVideo(row: Row): ProductVideo {
  return {
    ...(row as unknown as ProductVideo),
    passed: Boolean(row.passed),
    selected: Boolean(row.selected),
    uploaded: Boolean(row.uploaded),
  };
}

// ---------- Products ----------

export function createProductWithJob(input: {
  id: string;
  name: string | null;
  details?: string | null;
  image: string | null;
  images?: string[];
  video: string | null;
  urls: string[];
  searchPhotos?: boolean;
  searchVideos?: boolean;
}): { product: Product; job: Job } {
  const stamp = now();
  const searchPhotos = input.searchPhotos !== false;
  const searchVideos = input.searchVideos !== false;
  const tx = db().transaction(() => {
    db()
      .prepare(
        `INSERT INTO products (id, stage, input_name, input_details, input_image, input_images, input_video, input_urls, search_photos, search_videos, created_at, updated_at)
         VALUES (?, 'researching', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.name,
        input.details ?? null,
        input.image,
        JSON.stringify(input.images?.length ? input.images : input.image ? [input.image] : []),
        input.video,
        JSON.stringify(input.urls),
        searchPhotos ? 1 : 0,
        searchVideos ? 1 : 0,
        stamp,
        stamp,
      );
    return enqueueJob(input.id, false);
  });
  const job = tx();
  return { product: getProduct(input.id)!, job };
}

export function getProduct(id: string): Product | null {
  const row = db().prepare("SELECT * FROM products WHERE id = ?").get(id) as Row | undefined;
  return row ? toProduct(row) : null;
}

export function listProducts(stages: ProductStage[]): Product[] {
  const marks = stages.map(() => "?").join(",");
  const rows = db()
    .prepare(`SELECT * FROM products WHERE stage IN (${marks}) ORDER BY created_at DESC`)
    .all(...stages) as Row[];
  return rows.map(toProduct);
}

/** Finished reviews other than the one just completed move to History. */
export function archiveOtherReviews(keepId: string): void {
  db().prepare("UPDATE products SET stage = 'history', updated_at = ? WHERE stage = 'review' AND id != ?").run(now(), keepId);
}

export function countByStage(): Record<string, number> {
  const rows = db().prepare("SELECT stage, COUNT(*) AS n FROM products GROUP BY stage").all() as { stage: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.stage, r.n]));
}

/** Approved means accepted from review and not sent yet. Pushed means a Shopify product already exists. */
export function listingSplit(): { approved: number; pushed: number } {
  const row = db()
    .prepare(
      `SELECT
         SUM(CASE WHEN shopify_product_id IS NULL THEN 1 ELSE 0 END) AS approved,
         SUM(CASE WHEN shopify_product_id IS NOT NULL THEN 1 ELSE 0 END) AS pushed
       FROM products WHERE stage = 'listing'`,
    )
    .get() as { approved: number | null; pushed: number | null };
  return { approved: row.approved ?? 0, pushed: row.pushed ?? 0 };
}

const JSON_FIELDS = new Set(["input_urls", "blocked_urls", "vision", "name_options", "claims", "warnings", "shopify_warnings"]);
const PRODUCT_FIELDS = new Set([
  "stage", "input_urls", "blocked_urls", "vision", "name", "name_options", "category", "description", "source_text", "claims",
  "seller_name", "low_images", "warnings", "sku", "price", "cost", "shopify_status", "shopify_product_id",
  "shopify_admin_url", "shopify_handle", "shopify_error", "shopify_warnings",
]);

export function updateProduct(id: string, fields: Partial<Product>): void {
  const keys = Object.keys(fields);
  for (const key of keys) {
    if (!PRODUCT_FIELDS.has(key)) throw new Error(`Unknown product field: ${key}`);
  }
  if (!keys.length) return;
  const values = keys.map((key) => {
    const value = (fields as Record<string, unknown>)[key];
    if (JSON_FIELDS.has(key)) return value === null ? null : JSON.stringify(value);
    return typeof value === "boolean" ? Number(value) : value;
  });
  db()
    .prepare(`UPDATE products SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
    .run(...(values as never[]), now(), id);
}

/**
 * Clears web results from a previous run, ready for a new one. The user's uploads and
 * the AI's analysis of them are kept, because repeating that can take minutes.
 */
export function resetResearch(id: string): void {
  const tx = db().transaction(() => {
    db().prepare("DELETE FROM sources WHERE product_id = ?").run(id);
    db().prepare("DELETE FROM images WHERE product_id = ? AND uploaded = 0").run(id);
    db().prepare("DELETE FROM videos WHERE product_id = ? AND uploaded = 0").run(id);
    updateProduct(id, {
      name: null, name_options: [], category: null, description: null, source_text: null, claims: [],
      seller_name: null, low_images: false, warnings: [],
    });
  });
  tx();
}

// ---------- Jobs ----------

export function enqueueJob(productId: string, skipSearch: boolean): Job {
  const stamp = now();
  const id = randomUUID();
  const { seq } = db().prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM jobs").get() as { seq: number };
  db()
    .prepare(
      `INSERT INTO jobs (id, seq, product_id, status, step, skip_search, created_at, updated_at)
       VALUES (?, ?, ?, 'QUEUED', 'Waiting in queue', ?, ?, ?)`,
    )
    .run(id, seq, productId, skipSearch ? 1 : 0, stamp, stamp);
  return getJob(id)!;
}

export function getJob(id: string): Job | null {
  const row = db().prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
  return row ? toJob(row) : null;
}

export function latestJob(productId: string): Job | null {
  const row = db().prepare("SELECT * FROM jobs WHERE product_id = ? ORDER BY seq DESC LIMIT 1").get(productId) as Row | undefined;
  return row ? toJob(row) : null;
}

export function listRecentJobs(limit = 30): (Job & { product_name: string | null; product_stage: ProductStage; search_photos: boolean; search_videos: boolean })[] {
  const rows = db()
    .prepare(
      `SELECT j.*, COALESCE(p.name, p.input_name) AS product_name, p.stage AS product_stage,
              p.search_photos AS search_photos, p.search_videos AS search_videos
       FROM jobs j JOIN products p ON p.id = j.product_id ORDER BY j.seq DESC LIMIT ?`,
    )
    .all(limit) as Row[];
  return rows.map((row) => ({
    ...toJob(row),
    product_name: row.product_name as string | null,
    product_stage: row.product_stage as ProductStage,
    search_photos: row.search_photos === undefined ? true : Boolean(row.search_photos),
    search_videos: row.search_videos === undefined ? true : Boolean(row.search_videos),
  }));
}

/** Sum of every research request, plus how many listings Shopify has accepted. */
export function usageTotals(): { requests: number; usage: RequestUsage; shopifyDrafts: number } {
  const rows = db().prepare("SELECT usage FROM jobs").all() as { usage: string }[];
  const usage = rows.reduce((sum, row) => {
    const item = normalizeUsage(parse<Partial<RequestUsage>>(row.usage, {}));
    return {
      serpapi: sum.serpapi + item.serpapi,
      fastmoss: sum.fastmoss + item.fastmoss,
      aiInput: sum.aiInput + item.aiInput,
      aiOutput: sum.aiOutput + item.aiOutput,
    };
  }, { ...EMPTY_USAGE });
  const drafts = db().prepare("SELECT COUNT(*) AS n FROM products WHERE shopify_status = 'draft'").get() as { n: number };
  return { requests: rows.length, usage, shopifyDrafts: drafts.n };
}

export function setUsage(jobId: string, usage: RequestUsage): void {
  db().prepare("UPDATE jobs SET usage = ? WHERE id = ?").run(JSON.stringify(normalizeUsage(usage)), jobId);
}

/** Adds to the job that is running now. Research runs one job at a time. */
export function noteRunningUsage(delta: Partial<RequestUsage>): void {
  const row = db().prepare("SELECT id, usage FROM jobs WHERE status = 'RUNNING' ORDER BY seq DESC LIMIT 1").get() as { id: string; usage: string } | undefined;
  if (!row) return;
  const current = normalizeUsage(parse<Partial<RequestUsage>>(row.usage, {}));
  setUsage(row.id, {
    serpapi: current.serpapi + (delta.serpapi ?? 0),
    fastmoss: current.fastmoss + (delta.fastmoss ?? 0),
    aiInput: current.aiInput + (delta.aiInput ?? 0),
    aiOutput: current.aiOutput + (delta.aiOutput ?? 0),
  });
}

export function emptyUsage(): RequestUsage {
  return { ...EMPTY_USAGE };
}

export function hasActiveJob(productId: string): boolean {
  return Boolean(db().prepare("SELECT 1 FROM jobs WHERE product_id = ? AND status IN ('QUEUED','RUNNING')").get(productId));
}

/** Atomically takes the oldest queued job. */
export function claimNextJob(): Job | null {
  const row = db()
    .prepare(
      `UPDATE jobs SET status = 'RUNNING', attempts = attempts + 1, updated_at = ?
       WHERE id = (SELECT id FROM jobs WHERE status = 'QUEUED' ORDER BY seq LIMIT 1)
       RETURNING *`,
    )
    .get(now()) as Row | undefined;
  return row ? toJob(row) : null;
}

export function setJobStep(id: string, step: string): void {
  const job = getJob(id);
  if (!job) return;
  const log = [...job.log, { at: now(), text: step }].slice(-200);
  db().prepare("UPDATE jobs SET step = ?, log = ?, updated_at = ? WHERE id = ?").run(step, JSON.stringify(log), now(), id);
}

export function finishJob(id: string, status: Exclude<JobStatus, "QUEUED" | "RUNNING">, step: string, message: string | null): void {
  const stamp = now();
  db().prepare("UPDATE jobs SET status = ?, step = ?, message = ?, updated_at = ?, finished_at = ? WHERE id = ?").run(status, step, message, stamp, stamp, id);
}

/**
 * Runs at startup. Jobs that were RUNNING when the app stopped go back in the queue
 * and restart from the top, unless they have already been retried too many times.
 */
export function recoverJobs(maxAttempts: number): void {
  const stamp = now();
  const running = db().prepare("SELECT * FROM jobs WHERE status = 'RUNNING'").all() as Row[];
  for (const row of running) {
    const job = toJob(row);
    if (job.attempts >= maxAttempts) {
      finishJob(job.id, "FAILED", "Stopped", `The app stopped during this job ${job.attempts} times, so it was not restarted again.`);
      updateProduct(job.product_id, { stage: "failed" });
    } else {
      const log = [...job.log, { at: stamp, text: "App restarted. Job returned to the queue." }];
      db().prepare("UPDATE jobs SET status = 'QUEUED', step = 'Waiting in queue (restarted)', log = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(log), stamp, job.id);
    }
  }
}

/**
 * Runs at startup. A send that was interrupted cannot still be running. If the
 * product ID was saved it succeeded, otherwise Retry can safely check Shopify for it.
 */
export function recoverSends(): void {
  const stamp = now();
  db().prepare("UPDATE products SET shopify_status = 'draft', updated_at = ? WHERE shopify_status = 'sending' AND shopify_product_id IS NOT NULL").run(stamp);
  db()
    .prepare("UPDATE products SET shopify_status = 'error', shopify_error = ?, updated_at = ? WHERE shopify_status = 'sending' AND shopify_product_id IS NULL")
    .run("The app stopped while sending. Click Retry. It checks Shopify first, so it will not create a duplicate.", stamp);
}

// ---------- Sources ----------

export function addSource(productId: string, source: { url: string; title?: string | null; seller?: string | null; status: SourceStatus; reason?: string | null; text?: string | null }): void {
  const { seq } = db().prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM sources WHERE product_id = ?").get(productId) as { seq: number };
  db()
    .prepare("INSERT INTO sources (id, product_id, url, title, seller, status, reason, text, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), productId, source.url, source.title ?? null, source.seller ?? null, source.status, source.reason ?? null, source.text ?? null, seq);
}

export function listSources(productId: string): Source[] {
  return db().prepare("SELECT * FROM sources WHERE product_id = ? ORDER BY seq").all(productId) as Source[];
}

// ---------- Images ----------

export function addImage(image: Omit<ProductImage, "id" | "selected" | "position"> & { position?: number }): ProductImage {
  const id = randomUUID();
  db()
    .prepare(
      `INSERT INTO images (id, product_id, file_name, source_url, source_page, width, height, bytes, phash, passed, reason, checks, position, uploaded)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, image.product_id, image.file_name, image.source_url, image.source_page, image.width, image.height, image.bytes, image.phash,
      Number(image.passed), image.reason, JSON.stringify(image.checks), image.position ?? 0, Number(image.uploaded));
  return getImage(id)!;
}

export function getImage(id: string): ProductImage | null {
  const row = db().prepare("SELECT * FROM images WHERE id = ?").get(id) as Row | undefined;
  return row ? toImage(row) : null;
}

export function listImages(productId: string): ProductImage[] {
  return (db().prepare("SELECT * FROM images WHERE product_id = ? ORDER BY position, rowid").all(productId) as Row[]).map(toImage);
}

export function updateImageCheck(id: string, passed: boolean, reason: string | null, checks: ImageChecks): void {
  db().prepare("UPDATE images SET passed = ?, reason = ?, checks = ? WHERE id = ?").run(Number(passed), reason, JSON.stringify(checks), id);
}

export function setImageOrder(productId: string, orderedSelectedIds: string[]): void {
  const tx = db().transaction(() => {
    db().prepare("UPDATE images SET selected = 0 WHERE product_id = ?").run(productId);
    const update = db().prepare("UPDATE images SET selected = 1, position = ? WHERE id = ? AND product_id = ?");
    orderedSelectedIds.forEach((id, index) => update.run(index, id, productId));
  });
  tx();
}

/** Sets the display order of every image and which ones are preselected. */
export function rankImages(productId: string, orderedIds: string[], selectedIds: string[]): void {
  const tx = db().transaction(() => {
    const update = db().prepare("UPDATE images SET position = ?, selected = ? WHERE id = ? AND product_id = ?");
    orderedIds.forEach((id, index) => update.run(index, Number(selectedIds.includes(id)), id, productId));
  });
  tx();
}

// ---------- Videos ----------

export function addVideo(video: Omit<ProductVideo, "id" | "position">): ProductVideo {
  const id = randomUUID();
  const { position } = db().prepare("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM videos WHERE product_id = ?").get(video.product_id) as { position: number };
  db()
    .prepare(
      `INSERT INTO videos (id, product_id, kind, provider, url, file_name, source_page, bytes, passed, reason, selected, position, uploaded)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, video.product_id, video.kind, video.provider, video.url, video.file_name, video.source_page, video.bytes,
      Number(video.passed), video.reason, Number(video.selected), position, Number(video.uploaded));
  return listVideos(video.product_id).find((v) => v.id === id)!;
}

export function listVideos(productId: string): ProductVideo[] {
  return (db().prepare("SELECT * FROM videos WHERE product_id = ? ORDER BY position, rowid").all(productId) as Row[]).map(toVideo);
}

export function setVideoOrder(productId: string, orderedSelectedIds: string[]): void {
  const tx = db().transaction(() => {
    db().prepare("UPDATE videos SET selected = 0 WHERE product_id = ?").run(productId);
    const update = db().prepare("UPDATE videos SET selected = 1, position = ? WHERE id = ? AND product_id = ?");
    orderedSelectedIds.forEach((id, index) => update.run(index, id, productId));
  });
  tx();
}

// ---------- Listing ----------

/** The next free SKU, like PRD-0001. Numbers are never reused, even if a SKU is edited later. */
export function nextSku(): string {
  const tx = db().transaction(() => {
    const taken = db().prepare("SELECT 1 FROM products WHERE sku = ?");
    for (;;) {
      const { value } = db()
        .prepare("INSERT INTO counters (name, value) VALUES ('sku', 1) ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value")
        .get() as { value: number };
      const sku = `PRD-${String(value).padStart(4, "0")}`;
      if (!taken.get(sku)) return sku;
    }
  });
  return tx();
}

export function skuTakenByOther(productId: string, sku: string): boolean {
  return Boolean(db().prepare("SELECT 1 FROM products WHERE sku = ? AND id <> ?").get(sku, productId));
}

/**
 * The duplicate guard. A single conditional UPDATE, so only one caller can move a
 * product into 'sending', and never once a Shopify ID has been saved.
 */
/** Moves an existing Shopify draft into 'sending' so an update cannot run twice at once. */
export function claimForUpdate(productId: string): boolean {
  const result = db()
    .prepare(
      `UPDATE products
       SET shopify_status = 'sending', shopify_error = NULL, shopify_warnings = '[]', updated_at = ?
       WHERE id = ? AND stage = 'listing' AND shopify_product_id IS NOT NULL AND shopify_status IN ('draft', 'error')`,
    )
    .run(now(), productId);
  return result.changes === 1;
}

export function claimForSending(productId: string, handle: string): boolean {
  const result = db()
    .prepare(
      `UPDATE products
       SET shopify_status = 'sending', shopify_error = NULL, shopify_warnings = '[]',
           shopify_handle = COALESCE(shopify_handle, ?), updated_at = ?
       WHERE id = ? AND stage = 'listing' AND shopify_product_id IS NULL AND shopify_status IN ('ready', 'error')`,
    )
    .run(handle, now(), productId);
  return result.changes === 1;
}

export function setShopifyResult(
  productId: string,
  fields: { status: ShopifyStatus; productId?: string; adminUrl?: string; error?: string | null; warnings?: string[] },
): void {
  updateProduct(productId, {
    shopify_status: fields.status,
    ...(fields.productId !== undefined ? { shopify_product_id: fields.productId } : {}),
    ...(fields.adminUrl !== undefined ? { shopify_admin_url: fields.adminUrl } : {}),
    ...(fields.error !== undefined ? { shopify_error: fields.error } : {}),
    ...(fields.warnings !== undefined ? { shopify_warnings: fields.warnings } : {}),
  });
}

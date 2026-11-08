import fs from "node:fs";
import path from "node:path";
import * as repo from "../repo";
import { descriptionToHtml } from "../sanitize";
import { shopifyCredentials } from "../settings";
import { mediaPath } from "../storage";
import type { Product, ProductImage, ProductVideo } from "../types";
import { graphql, missingShopifySettings, ShopifyError } from "./client";

const FIND_BY_HANDLE = /* GraphQL */ `
  query FindDraftByHandle($identifier: ProductIdentifierInput!) {
    productByIdentifier(identifier: $identifier) {
      id
      status
    }
  }
`;

const STAGED_UPLOADS = /* GraphQL */ `
  mutation StagedUploads($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters {
          name
          value
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const PRODUCT_SET = /* GraphQL */ `
  mutation CreateDraftProduct($input: ProductSetInput!, $synchronous: Boolean!) {
    productSet(input: $input, synchronous: $synchronous) {
      product {
        id
        status
        handle
      }
      userErrors {
        code
        field
        message
      }
    }
  }
`;

const MEDIA_STATUS = /* GraphQL */ `
  query DraftMediaStatus($id: ID!) {
    product(id: $id) {
      media(first: 50) {
        nodes {
          id
          status
          mediaContentType
          mediaErrors {
            code
            message
          }
        }
      }
    }
  }
`;

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

interface LocalFile {
  file: string;
  fileName: string;
  mimeType: string;
  size: number;
  resource: "IMAGE" | "VIDEO";
}

function localFile(productId: string, kind: "images" | "videos", fileName: string): LocalFile {
  const file = mediaPath(productId, kind, fileName);
  const ext = path.extname(fileName).slice(1).toLowerCase();
  const mimeType = MIME_BY_EXT[ext];
  if (!mimeType) throw new ShopifyError(`Unsupported file type: ${fileName}`);
  if (!fs.existsSync(file)) throw new ShopifyError(`A selected file is missing from storage: ${fileName}`);
  return { file, fileName, mimeType, size: fs.statSync(file).size, resource: kind === "images" ? "IMAGE" : "VIDEO" };
}

/** Uploads local files through staged upload targets and returns the resource URLs, in order. */
async function uploadFiles(files: LocalFile[]): Promise<string[]> {
  if (!files.length) return [];
  const data = await graphql<{
    stagedUploadsCreate: {
      stagedTargets: { url: string | null; resourceUrl: string | null; parameters: { name: string; value: string }[] }[];
      userErrors: { field: string[] | null; message: string }[];
    };
  }>(STAGED_UPLOADS, {
    input: files.map((item) => ({
      filename: item.fileName,
      mimeType: item.mimeType,
      resource: item.resource,
      httpMethod: "POST",
      fileSize: String(item.size),
    })),
  });
  const { stagedTargets, userErrors } = data.stagedUploadsCreate;
  if (userErrors.length) throw new ShopifyError(`Shopify rejected the upload request: ${userErrors.map((e) => e.message).join("; ")}`);

  const resourceUrls: string[] = [];
  for (const [index, item] of files.entries()) {
    const target = stagedTargets[index];
    if (!target?.url || !target.resourceUrl) throw new ShopifyError(`Shopify gave no upload target for ${item.fileName}`);
    const form = new FormData();
    for (const parameter of target.parameters) form.append(parameter.name, parameter.value);
    // The file field must come last. openAsBlob streams from disk, so a 1 GB video
    // is not loaded into memory.
    const blob = await fs.openAsBlob(item.file, { type: item.mimeType });
    form.append("file", blob, item.fileName);
    let response: Response;
    try {
      response = await fetch(target.url, { method: "POST", body: form, signal: AbortSignal.timeout(60 * 60_000) });
    } catch (error) {
      throw new ShopifyError(`Upload of ${item.fileName} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ShopifyError(`Upload of ${item.fileName} failed (HTTP ${response.status}): ${text.slice(0, 200)}`);
    }
    await response.body?.cancel();
    resourceUrls.push(target.resourceUrl);
  }
  return resourceUrls;
}

function adminUrl(gid: string): string {
  const numericId = gid.split("/").pop();
  return `https://${shopifyCredentials().domain}/admin/products/${numericId}`;
}

/** A stable handle is what lets Retry find a product whose creation response was lost. */
export function makeHandle(product: Pick<Product, "id" | "name" | "sku">): string {
  const slug = (product.name || "product")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "") // Drops the accent that NFKD split off, so "é" becomes "e".
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return [slug || "product", (product.sku || "").toLowerCase().replace(/[^a-z0-9-]/g, ""), product.id.slice(0, 8)].filter(Boolean).join("-");
}

export interface BuildInputArgs {
  product: Product;
  imageSources: { source: string }[];
  fileVideoSources: { source: string }[];
  externalVideos: string[];
}

/**
 * Builds the productSet input. Status is always DRAFT and vendor is never set, so the
 * source seller's name cannot reach it.
 */
export function buildProductInput({ product, imageSources, fileVideoSources, externalVideos }: BuildInputArgs) {
  const title = (product.name || "").trim();
  const price = product.price?.trim() ? product.price.trim() : "0.00";
  const cost = product.cost?.trim();
  return {
    title,
    handle: product.shopify_handle,
    descriptionHtml: descriptionToHtml(product.description || ""),
    status: "DRAFT" as const,
    productOptions: [{ name: "Title", values: [{ name: "Default Title" }] }],
    variants: [
      {
        optionValues: [{ optionName: "Title", name: "Default Title" }],
        price,
        sku: product.sku,
        ...(cost ? { inventoryItem: { cost } } : {}),
      },
    ],
    files: [
      ...imageSources.map(({ source }) => ({ originalSource: source, contentType: "IMAGE", alt: title })),
      ...fileVideoSources.map(({ source }) => ({ originalSource: source, contentType: "VIDEO", alt: title })),
      ...externalVideos.map((source) => ({ originalSource: source, contentType: "EXTERNAL_VIDEO", alt: title })),
    ],
  };
}

export type StartResult = { started: true } | { started: false; reason: string; status: number };

/**
 * Starts a send unless one is running or the product already exists in Shopify.
 * The claim is atomic, so a double click cannot start two sends.
 */
export function startSend(productId: string): StartResult {
  const product = repo.getProduct(productId);
  if (!product) return { started: false, reason: "Product not found", status: 404 };
  if (product.stage !== "listing") return { started: false, reason: "Only products in the Listing tab can be sent to Shopify.", status: 409 };
  if (product.shopify_product_id) return { started: false, reason: "This product already exists in Shopify, so no new product was created.", status: 409 };

  const missing = missingShopifySettings();
  if (missing.length) {
    repo.setShopifyResult(productId, { status: "error", error: `Shopify is not connected. Open the Shopify tab and fill in: ${missing.join(", ")}.` });
    return { started: false, reason: "Shopify is not set up", status: 400 };
  }
  if (!(product.name || "").trim()) {
    repo.setShopifyResult(productId, { status: "error", error: "The product needs a name." });
    return { started: false, reason: "The product needs a name.", status: 400 };
  }
  if (!repo.claimForSending(productId, makeHandle(product))) {
    return { started: false, reason: "This product is already being sent.", status: 409 };
  }

  runSend(productId).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[shopify] send failed for ${productId}:`, error);
    repo.setShopifyResult(productId, { status: "error", error: message });
  });
  return { started: true };
}

async function runSend(productId: string): Promise<void> {
  const product = repo.getProduct(productId)!;

  // A previous attempt may have created the product and then lost the response, for
  // example on a timeout or restart. Adopt that product instead of creating another.
  const existing = await graphql<{ productByIdentifier: { id: string; status: string } | null }>(FIND_BY_HANDLE, {
    identifier: { handle: product.shopify_handle },
  });
  if (existing.productByIdentifier) {
    const { id, status } = existing.productByIdentifier;
    repo.setShopifyResult(productId, {
      status: "draft",
      productId: id,
      adminUrl: adminUrl(id),
      error: null,
      warnings: ["A product from an earlier attempt was already in Shopify, so it was linked instead of creating a duplicate. Check that its media is complete."].concat(
        status === "DRAFT" ? [] : [`Shopify reports this product's status as ${status}.`],
      ),
    });
    return;
  }

  const images: ProductImage[] = repo.listImages(productId).filter((image) => image.selected && image.file_name);
  const videos: ProductVideo[] = repo.listVideos(productId).filter((video) => video.selected);
  const fileVideos = videos.filter((video) => video.kind === "file" && video.file_name);
  const linkVideos = videos.filter((video) => video.kind === "link" && video.url);
  const externalVideos = linkVideos.filter((video) => video.provider === "youtube" || video.provider === "vimeo");
  const warnings: string[] = [];
  for (const video of linkVideos) {
    if (!externalVideos.includes(video)) warnings.push(`Not attached: Shopify cannot embed this ${video.provider} link (${video.url}).`);
  }
  if (!product.price?.trim()) warnings.push("No selling price was set, so the draft was created at 0.00.");

  const uploads = await uploadFiles([
    ...images.map((image) => localFile(productId, "images", image.file_name!)),
    ...fileVideos.map((video) => localFile(productId, "videos", video.file_name!)),
  ]);

  const input = buildProductInput({
    product,
    imageSources: uploads.slice(0, images.length).map((source) => ({ source })),
    fileVideoSources: uploads.slice(images.length).map((source) => ({ source })),
    externalVideos: externalVideos.map((video) => video.url!),
  });

  const data = await graphql<{
    productSet: {
      product: { id: string; status: string; handle: string } | null;
      userErrors: { code: string | null; field: string[] | null; message: string }[];
    };
  }>(PRODUCT_SET, { input, synchronous: true });
  const { product: created, userErrors } = data.productSet;
  if (userErrors.length) throw new ShopifyError(userErrors.map((e) => (e.field?.length ? `${e.field.join(".")}: ${e.message}` : e.message)).join("; "));
  if (!created) throw new ShopifyError("Shopify did not return the new product.");

  if (created.status !== "DRAFT") warnings.push(`Shopify reports this product's status as ${created.status}, not DRAFT. Please check it.`);

  // Saved before anything else that could fail, so a later problem can never create a second product.
  repo.setShopifyResult(productId, {
    status: "draft",
    productId: created.id,
    adminUrl: adminUrl(created.id),
    error: null,
    warnings,
  });

  await reportMediaProblems(productId, created.id, warnings).catch((error: unknown) => {
    console.error(`[shopify] could not read media status for ${productId}:`, error);
  });
}

/** Media is processed after creation. A failure here is a warning, since the draft exists. */
async function reportMediaProblems(productId: string, gid: string, warnings: string[]): Promise<void> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const data = await graphql<{
      product: { media: { nodes: { id: string; status: string; mediaContentType: string; mediaErrors: { code: string; message: string }[] }[] } } | null;
    }>(MEDIA_STATUS, { id: gid });
    const nodes = data.product?.media.nodes ?? [];
    const failed = nodes.filter((node) => node.status === "FAILED");
    const pending = nodes.filter((node) => node.status === "UPLOADED" || node.status === "PROCESSING");
    if (!pending.length || Date.now() > deadline) {
      const notes = failed.map((node) => `A ${node.mediaContentType.toLowerCase().replace("_", " ")} failed in Shopify: ${node.mediaErrors.map((e) => e.message).join("; ") || "no reason given"}`);
      if (pending.length) notes.push(`${pending.length} media item(s) were still processing in Shopify. Check them in the draft.`);
      if (notes.length) repo.setShopifyResult(productId, { status: "draft", warnings: [...warnings, ...notes] });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

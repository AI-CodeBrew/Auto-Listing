export type ProductStage = "researching" | "blocked" | "failed" | "review" | "listing" | "rejected" | "history";
export type JobStatus = "QUEUED" | "RUNNING" | "DONE" | "BLOCKED" | "FAILED";
export type ShopifyStatus = "ready" | "sending" | "draft" | "error";
export type SourceStatus = "accepted" | "rejected";
export type VideoKind = "file" | "link";

export interface Product {
  id: string;
  stage: ProductStage;
  input_name: string | null;
  /** What the user typed about the product. The main source of truth for the description. */
  input_details: string | null;
  input_image: string | null;
  /** Every photo the user attached. The first one is also input_image. */
  input_images: string[];
  input_video: string | null;
  input_urls: string[];
  /** When true, research searches Google Images through SerpAPI. */
  search_photos: boolean;
  /** When true, research searches TikTok videos through FastMoss. */
  search_videos: boolean;
  blocked_urls: string[];
  vision: VisionResult | null;
  name: string | null;
  name_options: string[];
  /** Short category tag written with the name and description, such as "Water bottles". */
  category: string | null;
  description: string | null;
  source_text: string | null;
  claims: string[];
  seller_name: string | null;
  low_images: boolean;
  warnings: string[];
  sku: string | null;
  price: string | null;
  cost: string | null;
  shopify_status: ShopifyStatus;
  shopify_product_id: string | null;
  shopify_admin_url: string | null;
  shopify_handle: string | null;
  shopify_error: string | null;
  shopify_warnings: string[];
  created_at: string;
  updated_at: string;
}

export interface Job {
  id: string;
  product_id: string;
  status: JobStatus;
  step: string | null;
  message: string | null;
  log: { at: string; text: string }[];
  skip_search: boolean;
  /** Paid calls made while this job ran. Dollar amounts are computed from these counts. */
  usage: RequestUsage;
  attempts: number;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface Source {
  id: string;
  product_id: string;
  url: string;
  title: string | null;
  seller: string | null;
  status: SourceStatus;
  reason: string | null;
  text: string | null;
}

export interface ImageChecks {
  minSize: boolean;
  duplicate: boolean;
  aiChecked: boolean;
  clear?: boolean;
  correctProduct?: boolean;
  noWatermark?: boolean;
  noOtherBrandLogo?: boolean;
  quality?: number;
  note?: string;
}

export interface ProductImage {
  id: string;
  product_id: string;
  file_name: string | null;
  source_url: string | null;
  source_page: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  phash: string | null;
  passed: boolean;
  reason: string | null;
  checks: ImageChecks;
  selected: boolean;
  position: number;
  uploaded: boolean;
}

export interface ProductVideo {
  id: string;
  product_id: string;
  kind: VideoKind;
  provider: string | null;
  url: string | null;
  file_name: string | null;
  source_page: string | null;
  bytes: number | null;
  passed: boolean;
  reason: string | null;
  selected: boolean;
  position: number;
  uploaded: boolean;
}

export interface RequestUsage {
  serpapi: number;
  fastmoss: number;
  aiInput: number;
  aiOutput: number;
}

export interface RequestCost {
  serpapiUsd: number;
  aiUsd: number;
  fastmossCredits: number;
  totalUsd: number;
}

/** SerpAPI allowance. The API key and account email are never included. */
export interface SerpPlan {
  planName: string;
  free: boolean;
  searchesPerMonth: number;
  searchesLeft: number;
  thisMonthUsage: number;
  thisHourSearches: number;
  hourlyLimit: number;
}

export interface VisionResult {
  product_type: string;
  key_features: string[];
  search_keywords: string[];
  confidence: number;
  frames_analyzed?: number;
}

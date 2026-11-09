export class CreativeError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "CreativeError";
  }
}

export interface YoutubeMetrics {
  views: number;
  likes: number;
  viewsPerDay: number;
  engagementPct: number;
}

export interface MetaMetrics {
  daysRunning: number;
  isActive: boolean;
  reach: number;
  duplicates: number;
  platforms: ("FACEBOOK" | "INSTAGRAM")[];
}

export interface RankedCreative {
  source: "youtube" | "facebook" | "instagram";
  id: string;
  title: string;
  text: string;
  author: string;
  url: string;
  thumbnail: string;
  startedAt: string;
  metrics: YoutubeMetrics | MetaMetrics;
  score: number;
  normalizedScore: number;
}

export interface FindResult {
  product: string;
  brand: string;
  model: string;
  color: string;
  packagingText: string;
  keywords: string[];
  quotaUsed: number;
  cached: boolean;
  checked: number;
  warnings: string[];
  youtube: RankedCreative[];
  meta: RankedCreative[];
  combined: RankedCreative[];
}

export interface CreativeRequest {
  image?: Buffer;
  imageUrl?: string;
  title?: string;
  brand?: string;
  model?: string;
  color?: string;
  packagingText?: string;
  keywords?: string[];
  shortsOnly: boolean;
  days: number;
}

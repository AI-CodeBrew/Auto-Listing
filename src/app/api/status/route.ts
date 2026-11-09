import { aiStatus } from "@/lib/ai";
import { config } from "@/lib/config";
import { priceUsage } from "@/lib/costs";
import { ok } from "@/lib/http";
import * as repo from "@/lib/repo";
import { serpPlan } from "@/lib/search/serpapi";
import { fastmossApiKey } from "@/lib/settings";
import { missingShopifySettings } from "@/lib/shopify/client";

/** Tab counts and setup state. Reports only which settings are missing, never their values. */
export async function GET() {
  const totals = repo.usageTotals();
  const recentGpt = repo
    .listRecentJobs(30)
    .filter((job) => job.usage.aiInput > 0 || job.usage.aiOutput > 0)
    .slice(0, 3)
    .map((job) => ({ id: job.id, name: job.product_name || "Product", aiUsd: priceUsage(job.usage).aiUsd }));
  return ok({
    counts: repo.countByStage(),
    listing: repo.listingSplit(),
    totals: { requests: totals.requests, shopifyDrafts: totals.shopifyDrafts, cost: priceUsage(totals.usage) },
    recentGpt,
    ai: await aiStatus(),
    shopifyMissing: missingShopifySettings(),
    serpapi: Boolean(config.serpApiKey()),
    serpPlan: await serpPlan(),
    fastmoss: Boolean(fastmossApiKey()),
    model: config.aiProvider() === "openai" ? config.openaiModel() : config.aiModel(),
  });
}


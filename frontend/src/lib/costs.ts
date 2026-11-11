import type { RequestCost, RequestUsage } from "./types";

/**
 * Published unit prices used to estimate a request.
 * SerpAPI's free plan includes 250 searches a month at no charge, so a search is
 * counted but not priced. The account endpoint reports how many are left.
 * OpenAI gpt-6-luna: $0.10 per million input tokens, $0.50 per million output tokens.
 * FastMoss bills in credits. One video search is counted as one credit; the dollar
 * price depends on the FastMoss plan, so it is not added into the dollar total.
 */
export const RATES = {
  serpapiUsd: 0,
  aiInputPerMillion: 0.1,
  aiOutputPerMillion: 0.5,
};

export const EMPTY_USAGE: RequestUsage = { serpapi: 0, fastmoss: 0, aiInput: 0, aiOutput: 0 };

export function normalizeUsage(value: Partial<RequestUsage> | null | undefined): RequestUsage {
  const num = (item: unknown) => (typeof item === "number" && Number.isFinite(item) ? item : 0);
  return {
    serpapi: num(value?.serpapi),
    fastmoss: num(value?.fastmoss),
    aiInput: num(value?.aiInput),
    aiOutput: num(value?.aiOutput),
  };
}

export function priceUsage(usage: RequestUsage): RequestCost {
  const aiUsd = (usage.aiInput / 1_000_000) * RATES.aiInputPerMillion + (usage.aiOutput / 1_000_000) * RATES.aiOutputPerMillion;
  return {
    serpapiUsd: 0,
    aiUsd,
    fastmossCredits: usage.fastmoss,
    totalUsd: aiUsd,
  };
}

/** Fixed decimal places so server and browser render the same text. */
export function money(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  return `${sign}$${Math.abs(amount).toFixed(4)}`;
}

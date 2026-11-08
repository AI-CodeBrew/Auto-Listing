import type { ListingDraft } from "../ai";

/** Claims that always need confirming, even if the AI did not flag them. */
const RISKY_CLAIMS = [
  /\bBPA[- ]free\b/gi,
  /\bmicrowave[- ]safe\b/gi,
  /\bdishwasher[- ]safe\b/gi,
  /\bfood[- ](safe|grade)\b/gi,
  /\boven[- ]safe\b/gi,
  /\bFDA[- ](approved|cleared|registered)\b/gi,
  /\bCE[- ]certified\b/gi,
  /\b(certified|hypoallergenic|non[- ]toxic|organic|lead[- ]free|phthalate[- ]free|waterproof|fireproof|antibacterial|clinically proven|eco[- ]friendly|biodegradable)\b/gi,
];

export const NEEDS_CHECKING = "[needs checking]";

const REVIEW_LANGUAGE = /(\b\d(\.\d)?\s*(\/\s*5|out of 5|stars?)\b|\bstars?\s+rat|\brated\b|\bratings?\b|\breviews?\b|\btestimonials?\b|\bcustomers? (love|say|rave)\b|\bbest[- ]?sell(er|ing)\b|★)/i;

function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Finds runs of at least `runLength` consecutive words shared with a source. This
 * is the code-level check for "do not copy the source text".
 */
export function findCopiedPhrases(text: string, sources: string[], runLength = 8): string[] {
  const words = wordsOf(text);
  if (words.length < runLength) return [];
  const sourceGrams = new Set<string>();
  for (const source of sources) {
    const sw = wordsOf(source);
    for (let i = 0; i + runLength <= sw.length; i++) sourceGrams.add(sw.slice(i, i + runLength).join(" "));
  }
  const phrases: string[] = [];
  for (let i = 0; i + runLength <= words.length; i++) {
    if (sourceGrams.has(words.slice(i, i + runLength).join(" "))) {
      let end = i + runLength;
      while (end < words.length && sourceGrams.has(words.slice(end - runLength + 1, end + 1).join(" "))) end++;
      phrases.push(words.slice(i, end).join(" "));
      i = end - 1;
    }
  }
  return phrases;
}

/** Removes store names from a name, for example "Acme Bottle - ShopMart" becomes "Acme Bottle". */
export function removeStoreWords(name: string, sellers: string[]): string {
  let result = name;
  for (const seller of sellers) {
    const clean = seller.trim();
    if (clean.length < 3) continue;
    const pattern = new RegExp(`(^|[\\s|\\-–—:(,])${clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s|\\-–—:),])`, "gi");
    result = result.replace(pattern, "$1");
  }
  return result
    .replace(/\s*[|\-–—:]\s*$/g, "")
    .replace(/^\s*[|\-–—:]\s*/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function dropReviewSentences(text: string): string {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !REVIEW_LANGUAGE.test(sentence))
    .join(" ")
    .trim();
}

/** Adds [needs checking] after each claim, once per place it appears. */
function markClaims(text: string, claims: string[]): string {
  let result = text;
  for (const claim of [...claims].sort((a, b) => b.length - a.length)) {
    const escaped = claim.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!escaped) continue;
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])(?!\\s*\\[needs checking\\])`, "giu");
    result = result.replace(pattern, (match) => `${match} ${NEEDS_CHECKING}`);
  }
  return result;
}

function detectRiskyClaims(text: string): string[] {
  const found = new Map<string, string>();
  for (const pattern of RISKY_CLAIMS) {
    for (const match of text.matchAll(pattern)) found.set(match[0].toLowerCase(), match[0]);
  }
  return [...found.values()];
}

/** Applies the rules from the spec to the AI draft and returns the editable text. */
export function finalizeListing(draft: ListingDraft, sellers: string[], fallbackName: string) {
  const name = removeStoreWords(draft.best_name, sellers) || fallbackName;
  const nameOptions = [...new Set(draft.name_options.map((option) => removeStoreWords(option, sellers)).filter(Boolean))].filter(
    (option) => option.toLowerCase() !== name.toLowerCase(),
  );
  const paragraph = dropReviewSentences(draft.description);
  const bullets = draft.feature_bullets
    .map((bullet) => bullet.replace(/^[-*•]\s*/, "").trim())
    .filter((bullet) => bullet && !REVIEW_LANGUAGE.test(bullet));
  const plain = [paragraph, ...bullets].join("\n");
  const claims = [
    ...new Map(
      [...draft.claims_needing_check.map((c) => c.trim()).filter(Boolean), ...detectRiskyClaims(plain)].map((claim) => [claim.toLowerCase(), claim]),
    ).values(),
  ];
  const description = [markClaims(paragraph, claims), "", ...bullets.map((bullet) => `- ${markClaims(bullet, claims)}`)].join("\n").trim();
  return { name, nameOptions, description, claims };
}

/** Ranks passing images and returns the IDs to preselect (5 to 10 when that many pass). */
export function chooseBestImages<T extends { id: string; passed: boolean; uploaded: boolean; width: number | null; height: number | null; checks: { quality?: number } }>(
  images: T[],
  max: number,
): string[] {
  return images
    .filter((image) => image.passed)
    .sort((a, b) => {
      const quality = (b.checks.quality ?? 0) - (a.checks.quality ?? 0);
      if (a.uploaded !== b.uploaded) return a.uploaded ? -1 : 1;
      if (quality !== 0) return quality;
      return (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0);
    })
    .slice(0, max)
    .map((image) => image.id);
}

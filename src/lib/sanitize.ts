import sanitizeHtml from "sanitize-html";

/** Reduces untrusted HTML to plain text. Scripts and styles lose their contents too. */
export function toPlainText(input: string | null | undefined): string {
  if (!input) return "";
  const stripped = sanitizeHtml(input, {
    allowedTags: [],
    allowedAttributes: {},
    disallowedTagsMode: "discard",
    nonTextTags: ["script", "style", "textarea", "noscript", "iframe", "object", "embed"],
  });
  return decodeBasicEntities(stripped)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeBasicEntities(text: string): string {
  // Decoding can reveal new markup such as &lt;script&gt;. Every consumer treats
  // this result as text and escapes it on output (React, or escapeHtml below).
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&");
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Turns the editable description into the HTML sent to Shopify. Lines starting
 * with "- " or "* " become list items and the rest become paragraphs. All text
 * is escaped, so no markup from any source can reach the store.
 */
export function descriptionToHtml(description: string): string {
  const out: string[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length) out.push(`<ul>${bullets.map((b) => `<li>${b}</li>`).join("")}</ul>`);
    bullets = [];
  };
  for (const raw of description.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    if (bullet) {
      bullets.push(escapeHtml(bullet[1]));
    } else {
      flush();
      out.push(`<p>${escapeHtml(line)}</p>`);
    }
  }
  flush();
  return out.join("");
}

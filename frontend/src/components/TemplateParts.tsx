"use client";

import { useEffect, useState, type ReactNode } from "react";
import { safeHref } from "./api";

export interface Push {
  domain: string;
  themeId: string;
  themeName: string;
  previewUrl: string;
  productPreviewUrl: string | null;
  editorUrl: string;
  at: string;
}

export interface PushResult extends Push {
  uploaded: number;
  unchanged: number;
  removed: number;
  warnings: string[];
}

/**
 * Starts a theme push and reads its progress. The server sends one JSON object per line: progress
 * steps, then "done" or "error". Resolves with the result, or throws with the reason it failed.
 */
export async function pushTemplate(templateId: string, onStep: (step: string) => void): Promise<PushResult> {
  const response = await fetch(`/api/templates/${templateId}/push`, { method: "POST", cache: "no-store" });
  if (!response.ok || !response.body) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += value;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const event = JSON.parse(line) as { type: string; step?: string; result?: PushResult; message?: string };
      if (event.type === "progress" && event.step) onStep(event.step);
      if (event.type === "done" && event.result) return event.result;
      if (event.type === "error") throw new Error(event.message ?? "The push failed.");
    }
    if (done) break;
  }
  throw new Error("The connection closed before the push finished. Check Online Store → Themes in your Shopify admin.");
}

/** The page as the store draws it: the real Liquid files, rendered once with sample content. */
export function RenderedPreview({
  name,
  src,
  note,
  resolvePage,
  onClose,
}: {
  name: string;
  src: string;
  note: string;
  /** For a whole store: where a link clicked inside the preview goes (a path in the sample store), or null to stay. */
  resolvePage?: (href: string) => string | null;
  onClose: () => void;
}) {
  const [page, setPage] = useState(src);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    // Escape pressed inside the page, or a link followed in it: the page tells this window.
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data === "fynk-close-preview") onClose();
      const data = event.data as { type?: string; href?: string } | null;
      if (resolvePage && data?.type === "SIMMER_PREVIEW_NAVIGATE" && typeof data.href === "string") {
        const next = resolvePage(data.href);
        if (next) setPage(next);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("message", onMessage);
    };
  }, [onClose, resolvePage]);
  return (
    <div className="sp-overlay" role="dialog" aria-modal="true" aria-label={`${name} preview`} data-testid="rendered-preview">
      <div className="sp-bar">
        <p>
          <strong>{name}</strong> · {note}
        </p>
        <button className="btn" type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <iframe className="tpl-frame" src={page} title={`${name} preview`} data-testid="rendered-frame" />
    </div>
  );
}

export function PushLinks({ links, before }: { links: { label: string; href: string | null }[]; before?: ReactNode }) {
  return (
    <span className="tpl-links">
      {before}
      {links.map((link) => {
        const href = safeHref(link.href);
        return href ? (
          <a key={link.label} className="tpl-link" href={href} target="_blank" rel="noopener noreferrer">
            {link.label}
          </a>
        ) : null;
      })}
    </span>
  );
}

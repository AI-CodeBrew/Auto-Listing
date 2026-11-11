"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export async function api<T = unknown>(url: string, init?: { method?: string; json?: unknown; form?: FormData }): Promise<T> {
  const response = await fetch(url, {
    method: init?.method ?? (init?.json !== undefined || init?.form ? "POST" : "GET"),
    headers: init?.json !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.form ?? (init?.json !== undefined ? JSON.stringify(init.json) : undefined),
    cache: "no-store",
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

/** Fetches a URL now and then repeatedly. Pauses while the browser tab is hidden. */
export function usePolling<T>(url: string, intervalMs: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const urlRef = useRef(url);
  urlRef.current = url;

  const pending = useRef(false);
  const refresh = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    try {
      const body = await api<T>(urlRef.current);
      setData(body);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      pending.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [refresh, intervalMs, url]);

  return { data, error, refresh };
}

/** Links come from web pages, so only http(s) may ever become an href. */
export function safeHref(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const text = parsed.hostname.replace(/^www\./, "") + parsed.pathname + parsed.search;
    return text.length > 60 ? `${text.slice(0, 57)}...` : text;
  } catch {
    return url;
  }
}

export function formatBytes(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const fileUrl = (productId: string, kind: "images" | "videos", name: string) =>
  `/api/files/${productId}/${kind}/${encodeURIComponent(name)}`;

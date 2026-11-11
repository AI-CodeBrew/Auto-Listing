"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/components/api";

interface YoutubeMetrics {
  views: number;
  likes: number;
  viewsPerDay: number;
  engagementPct: number;
}

interface MetaMetrics {
  daysRunning: number;
  isActive: boolean;
  reach: number;
  duplicates: number;
  platforms: ("FACEBOOK" | "INSTAGRAM")[];
}

interface RankedCreative {
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

interface FindResult {
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

const STEPS = ["Analyzing image…", "Searching YouTube & Meta…", "Ranking…"];
type Tab = "all" | "youtube" | "facebook" | "instagram";
type Sort = "score" | "newest" | "running" | "views";
const IMAGE_MAX = 20 * 1024 * 1024;

export default function CreativesPage() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState("");
  const [dragging, setDragging] = useState(false);
  const [shortsOnly, setShortsOnly] = useState(true);
  const [days, setDays] = useState(180);
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FindResult | null>(null);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [sort, setSort] = useState<Sort>("score");
  const [tab, setTab] = useState<Tab>("all");
  const fileRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const previewRef = useRef<string | null>(null);
  previewRef.current = preview;

  useEffect(() => {
    return () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    };
  }, []);

  useEffect(() => {
    if (!loading) return;
    const timer = setInterval(() => setStep((current) => Math.min(current + 1, STEPS.length - 1)), 4000);
    return () => clearInterval(timer);
  }, [loading]);

  function chooseFile(next: File | null) {
    if (preview) URL.revokeObjectURL(preview);
    if (!next) {
      setFile(null);
      setPreview(null);
      return;
    }
    if (!next.type.startsWith("image/")) {
      setError("That file is not a readable image.");
      return;
    }
    if (next.size > IMAGE_MAX) {
      setError("Images can be at most 20 MB.");
      return;
    }
    setError(null);
    setFile(next);
    setPreview(URL.createObjectURL(next));
  }

  function addFiles(list: FileList | File[]) {
    const next = Array.from(list).find((item) => item.type.startsWith("image/")) ?? Array.from(list)[0] ?? null;
    chooseFile(next);
  }

  async function find(event: React.FormEvent) {
    event.preventDefault();
    if (!file && !imageUrl.trim()) {
      setError("Upload a product image or paste an image URL.");
      return;
    }
    const form = new FormData();
    if (file) form.append("file", file);
    else form.append("imageUrl", imageUrl.trim());
    form.append("shortsOnly", shortsOnly ? "1" : "0");
    form.append("days", String(days));
    await run(form, 0);
  }

  async function searchAgain() {
    const phrases = keywords.map((word) => word.trim()).filter(Boolean);
    if (!result || !phrases.length) {
      setError("Enter at least one search phrase.");
      return;
    }
    if (!file && !imageUrl.trim()) {
      setError("Keep the product image so the thumbnails can be checked against it.");
      return;
    }
    const details = {
      title: result.product,
      brand: result.brand,
      model: result.model,
      color: result.color,
      packagingText: result.packagingText,
      keywords: phrases,
      shortsOnly,
      days,
    };
    if (file) {
      const form = new FormData();
      form.append("file", file);
      form.append("title", details.title);
      form.append("brand", details.brand);
      form.append("model", details.model);
      form.append("color", details.color);
      form.append("packagingText", details.packagingText);
      form.append("keywords", JSON.stringify(phrases));
      form.append("shortsOnly", shortsOnly ? "1" : "0");
      form.append("days", String(days));
      await run(form, 1);
      return;
    }
    await run({ ...details, imageUrl: imageUrl.trim() }, 1);
  }

  async function run(
    body: FormData | { imageUrl?: string; title?: string; brand?: string; model?: string; color?: string; packagingText?: string; keywords?: string[]; shortsOnly: boolean; days: number },
    startStep: number,
  ) {
    setError(null);
    setStep(startStep);
    setLoading(true);
    try {
      const found = await api<FindResult>("/api/creatives/find", body instanceof FormData ? { form: body } : { json: body });
      setResult(found);
      setKeywords(found.keywords);
      setSort("score");
      setTab("all");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The search failed. Try again.");
    } finally {
      setLoading(false);
    }
  }

  const facebookAds = (result?.meta ?? []).filter((item) => item.source !== "youtube" && metaPlatforms(item).includes("FACEBOOK"));
  const instagramAds = (result?.meta ?? []).filter((item) => metaPlatforms(item).includes("INSTAGRAM"));
  const pool = tab === "youtube" ? (result?.youtube ?? []) : tab === "facebook" ? facebookAds : tab === "instagram" ? instagramAds : (result?.combined ?? []);
  const shown = [...pool].sort((a, b) => {
    if (sort === "newest") return Date.parse(b.startedAt) - Date.parse(a.startedAt);
    if (sort === "running") return runningDays(b) - runningDays(a);
    if (sort === "views") return viewCount(b) - viewCount(a);
    return b.normalizedScore - a.normalizedScore;
  });

  return (
    <div className="page stack">
      <div className="page-head">
        <h1>Find Creatives</h1>
        <p>Upload a product photo. The best-performing YouTube videos and Facebook or Instagram ads for that product are ranked here.</p>
      </div>

      <form className="card stack" onSubmit={find}>
        <div
          className={dragging ? "dropzone dropzone-on" : "dropzone"}
          onDragEnter={(event) => {
            event.preventDefault();
            dragDepth.current += 1;
            setDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => {
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (dragDepth.current === 0) setDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            dragDepth.current = 0;
            setDragging(false);
            addFiles(event.dataTransfer.files);
          }}
        >
          <input
            ref={fileRef}
            className="drop-input"
            type="file"
            accept="image/*"
            aria-label="Product image"
            onChange={(event) => {
              addFiles(event.target.files ?? []);
              event.target.value = "";
            }}
          />
          {preview ? (
            <div className="drop-filled">
              <div className="drop-grid">
                <figure className="drop-thumb">
                  <img src={preview} alt="" />
                  <button type="button" className="drop-remove" aria-label="Remove image" onClick={() => chooseFile(null)}>
                    ×
                  </button>
                </figure>
              </div>
            </div>
          ) : (
            <button type="button" className="drop-empty" onClick={() => fileRef.current?.click()}>
              <span className="drop-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M12 16V6M8 9l4-4 4 4" />
                  <path d="M5 18h14" />
                </svg>
              </span>
              Drop a product image here, or click to choose one
              <span className="muted small">One image, up to 20 MB</span>
            </button>
          )}
        </div>

        <label className="field">
          <span>Or paste an image URL</span>
          <input type="text" value={imageUrl} placeholder="https://…" onChange={(event) => setImageUrl(event.target.value)} data-testid="image-url" />
        </label>

        <div className="row row-wrap">
          <button type="button" className={shortsOnly ? "toggle toggle-on" : "toggle"} aria-pressed={shortsOnly} onClick={() => setShortsOnly((on) => !on)}>
            <span className="toggle-knob" aria-hidden="true" />
            <span className="toggle-copy">
              <strong>Shorts only</strong>
              <span className="muted small">Videos under 4 minutes</span>
            </span>
          </button>
          <label className="field">
            <span>Published within</span>
            <select value={days} onChange={(event) => setDays(Number(event.target.value))} aria-label="Published within">
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
              <option value={180}>180 days</option>
              <option value={365}>365 days</option>
            </select>
          </label>
          <button className="btn btn-primary" type="submit" disabled={loading} data-testid="find-creatives">
            {loading ? "Finding…" : "Find creatives"}
          </button>
        </div>
      </form>

      {error && (
        <p className="notice notice-error" data-testid="creative-error">
          {error}
        </p>
      )}

      {loading && (
        <p className="steps" aria-live="polite">
          {STEPS.map((label, index) => (
            <span key={label}>
              {index > 0 && " → "}
              {index === step ? <strong>{label}</strong> : label}
            </span>
          ))}
        </p>
      )}

      {result && (
        <section className="stack">
          <div className="card stack">
            <div>
              <div className="muted small">Detected product</div>
              <h2>{result.product}</h2>
              {[result.brand, result.model, result.color, result.packagingText].filter(Boolean).length > 0 && (
                <p className="muted small">{[result.brand, result.model, result.color, result.packagingText].filter(Boolean).join(" · ")}</p>
              )}
            </div>
            <div className="keyword-row">
              {keywords.map((word, index) => (
                <input
                  key={index}
                  type="text"
                  value={word}
                  aria-label={`Search phrase ${index + 1}`}
                  onChange={(event) => setKeywords((current) => current.map((item, itemIndex) => (itemIndex === index ? event.target.value : item)))}
                />
              ))}
            </div>
            <div className="row row-wrap">
              <button type="button" className="btn" onClick={() => setKeywords((current) => (current.length >= 8 ? current : [...current, ""]))} disabled={keywords.length >= 8}>
                Add phrase
              </button>
              <button type="button" className="btn btn-primary" onClick={searchAgain} disabled={loading}>
                Search again
              </button>
              <span className="muted small">
                {result.cached ? "Saved result from the last 24 hours." : `YouTube quota used: ${result.quotaUsed}`}
              </span>
            </div>
          </div>

          {(result.warnings ?? []).map((warning) => (
            <p key={warning} className="notice notice-warn">
              {warning}
            </p>
          ))}

          <div className="row row-between">
            <div className="source-tabs" role="tablist" aria-label="Result source">
              {(
                [
                  ["all", "All", result.combined.length],
                  ["youtube", "YouTube", result.youtube.length],
                  ["facebook", "Facebook", facebookAds.length],
                  ["instagram", "Instagram", instagramAds.length],
                ] as const
              ).map(([id, label, count]) => (
                <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "source-tab source-tab-on" : "source-tab"} onClick={() => setTab(id)}>
                  {label} ({count})
                </button>
              ))}
            </div>
            <label className="field">
              <span>Sort</span>
              <select value={sort} aria-label="Sort" onChange={(event) => setSort(event.target.value as Sort)}>
                <option value="score">Score</option>
                <option value="newest">Newest</option>
                <option value="running">Longest running</option>
                <option value="views">Most views</option>
              </select>
            </label>
          </div>

          {shown.length === 0 ? (
            <div className="card">
              <p>{tab === "youtube" ? "None of the checked videos showed this exact product." : "Nothing matched in this tab."}</p>
              <p className="muted small">Edit a search phrase or turn Shorts off, then search again.</p>
            </div>
          ) : (
            <div className="creative-grid">
              {shown.map((item, index) => (
                <CreativeCard key={`${item.source}-${item.id}`} item={item} rank={index + 1} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function CreativeCard({ item, rank }: { item: RankedCreative; rank: number }) {
  const youtube = item.source === "youtube";
  const metrics = item.metrics as YoutubeMetrics & MetaMetrics;
  const labels = youtube ? ["YouTube"] : [metrics.platforms.includes("FACEBOOK") ? "Facebook" : "", metrics.platforms.includes("INSTAGRAM") ? "Instagram" : ""].filter(Boolean);
  return (
    <article className="card creative-card" data-testid="creative-card">
      {youtube ? (
        <a className="creative-thumb" href={item.url} target="_blank" rel="noreferrer">
          {item.thumbnail ? <img src={item.thumbnail} alt="" /> : <span className="creative-thumb" />}
          <span className="creative-rank">{rank}</span>
        </a>
      ) : null}
      <div className="creative-body">
        <div className="row row-wrap">
          {!youtube && <span className="pill">{rank}</span>}
          {labels.map((label) => (
            <span key={label} className="pill">
              {label}
            </span>
          ))}
          <span className="pill pill-done">Score {item.normalizedScore}</span>
        </div>
        {youtube ? (
          <>
            <a className="creative-title" href={item.url} target="_blank" rel="noreferrer">
              {item.title}
            </a>
            <div className="muted small">{item.author}</div>
            <div className="creative-meta">
              <span>{metrics.views.toLocaleString()} views</span>
              <span>{metrics.viewsPerDay.toLocaleString()} / day</span>
              <span>{metrics.engagementPct}% engagement</span>
            </div>
          </>
        ) : (
          <>
            <div className="creative-title">{item.author}</div>
            <p className="ad-text">{item.text.slice(0, 150) || item.title}</p>
            <div className="creative-meta">
              <span>Running {metrics.daysRunning} days</span>
              {metrics.isActive && (
                <span className="row">
                  <span className="active-dot" aria-hidden="true" /> Active
                </span>
              )}
              <span>{metrics.reach.toLocaleString()} reach</span>
            </div>
            <a className="btn" href={item.url} target="_blank" rel="noreferrer">
              View ad
            </a>
          </>
        )}
      </div>
    </article>
  );
}

function metaPlatforms(item: RankedCreative): ("FACEBOOK" | "INSTAGRAM")[] {
  if (item.source === "youtube") return [];
  return (item.metrics as MetaMetrics).platforms;
}

function runningDays(item: RankedCreative): number {
  if (item.source !== "youtube") return (item.metrics as MetaMetrics).daysRunning;
  const started = Date.parse(item.startedAt);
  return Number.isFinite(started) ? (Date.now() - started) / 86_400_000 : 0;
}

function viewCount(item: RankedCreative): number {
  return item.source === "youtube" ? (item.metrics as YoutubeMetrics).views : -1;
}

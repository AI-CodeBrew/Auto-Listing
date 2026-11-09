"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api, fileUrl, formatBytes, safeHref, shortUrl, usePolling } from "@/components/api";
import { ResearchActivity } from "@/components/ResearchActivity";
import type { Job, Product, ProductImage, ProductStage, ProductVideo, Source } from "@/lib/types";

interface Detail {
  product: Product;
  images: ProductImage[];
  videos: ProductVideo[];
  sources: Omit<Source, "text">[];
  job: Job | null;
}

const ROW_STATUS: Partial<Record<ProductStage, string>> = {
  researching: "RUNNING",
  blocked: "BLOCKED",
  failed: "FAILED",
  review: "DONE",
  history: "DONE",
  rejected: "DONE",
};

const ROW_LABEL: Partial<Record<ProductStage, string>> = {
  researching: "Searching",
  blocked: "Needs links",
  failed: "Failed",
  review: "Ready",
  history: "Past",
  rejected: "Rejected",
};

export default function ReviewPage() {
  const { data, refresh } = usePolling<{ products: Product[] }>("/api/products?stages=researching,blocked,failed,review,history,rejected", 3000);
  const products = data?.products ?? [];

  return (
    <div className="page stack">
      <header className="page-head">
        <h1>Review listings</h1>
        <p>Open a search to see the title, description, and pictures.</p>
      </header>
      {data && products.length === 0 && <p className="muted">No searches yet.</p>}
      {products.map((product) => (
        <ResultRow key={product.id} product={product} onDone={refresh} />
      ))}
    </div>
  );
}

function ResultRow({ product, onDone }: { product: Product; onDone: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const title = product.name || product.input_name || "Product from your upload";
  const finished = product.stage === "review" || product.stage === "history" || product.stage === "rejected";

  return (
    <details
      className="card listing-fold"
      data-testid="job"
      data-status={ROW_STATUS[product.stage] ?? "DONE"}
      data-product={product.id}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="card-title">{title}</span>
        <span className={`pill pill-${product.stage === "failed" || product.stage === "blocked" ? "failed" : product.stage === "review" ? "done" : "muted"}`}>{ROW_LABEL[product.stage] ?? product.stage}</span>
      </summary>
      {open && (
        <div className="listing-body">
          {finished && <ReviewCard id={product.id} onDone={onDone} readOnly={product.stage !== "review"} />}
          {product.stage === "blocked" && <BlockedEditor id={product.id} onDone={onDone} />}
          {product.stage === "failed" && <FailedEditor id={product.id} onDone={onDone} />}
          {product.stage === "researching" && <ResearchActivity productId={product.id} />}
        </div>
      )}
    </details>
  );
}

function BlockedEditor({ id, onDone }: { id: string; onDone: () => Promise<void> }) {
  const [message, setMessage] = useState("Paste product page URLs to continue without searching.");
  const [urls, setUrls] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Detail>(`/api/products/${id}`).then((body) => {
      if (body.job?.message) setMessage(body.job.message);
    }).catch(() => undefined);
  }, [id]);

  return (
    <div className="notice notice-warn">
      <p role="alert">{message}</p>
      <label className="field">
        <span>Product page URLs</span>
        <textarea rows={3} value={urls} onChange={(e) => setUrls(e.target.value)} placeholder="One per line" data-testid="blocked-urls" />
      </label>
      {error && <p className="error">{error}</p>}
      <button
        className="btn btn-primary"
        disabled={busy || !urls.trim()}
        onClick={() => {
          setBusy(true);
          setError(null);
          api(`/api/products/${id}/research`, { json: { urls } })
            .then(onDone)
            .catch((e: Error) => {
              setError(e.message);
              setBusy(false);
            });
        }}
      >
        Continue with these URLs
      </button>
    </div>
  );
}

function FailedEditor({ id, onDone }: { id: string; onDone: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="row">
      {error && <span className="error">{error}</span>}
      <button className="btn" onClick={() => api(`/api/products/${id}/research`, { json: {} }).then(onDone).catch((e: Error) => setError(e.message))}>
        Try again
      </button>
    </div>
  );
}

const VIDEO_SETUP = "Video setup is not integrated yet.";

function shownWarnings(product: Product): string[] {
  const hidden = (warning: string) => warning.includes("PUBLIC_BASE_URL") || warning.includes("FASTMOSS_API_KEY") || warning.includes("Google Lens was not used");
  const rest = product.warnings.filter((warning) => warning !== VIDEO_SETUP && !hidden(warning));
  const missingVideoSetup = product.search_videos && product.warnings.some((warning) => warning === VIDEO_SETUP || warning.includes("FASTMOSS_API_KEY"));
  return missingVideoSetup ? [VIDEO_SETUP, ...rest] : rest;
}

function ReviewCard({ id, onDone, readOnly = false }: { id: string; onDone: () => Promise<void>; readOnly?: boolean }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [imageIds, setImageIds] = useState<Set<string>>(new Set());
  const [videoIds, setVideoIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Detail>(`/api/products/${id}`)
      .then((body) => {
        setDetail(body);
        setName(body.product.name ?? "");
        setCategory(body.product.category ?? "");
        setDescription(body.product.description ?? "");
        setImageIds(new Set(body.images.filter((image) => image.selected).map((image) => image.id)));
        setVideoIds(new Set(body.videos.filter((video) => video.selected).map((video) => video.id)));
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);

  if (!detail) return <div className="card muted">{error ?? "Loading..."}</div>;
  const { product, images, videos } = detail;
  const passedCount = images.filter((image) => image.passed).length;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  const toggle = (set: Set<string>, setter: (next: Set<string>) => void, itemId: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(itemId);
    else next.delete(itemId);
    setter(next);
  };

  return (
    <article className="stack" data-testid="review-card" data-product={id}>
      <div className="row row-between">
        <h2 className="card-title">{product.name}</h2>
        {product.low_images && (
          <span className="pill pill-warn" data-testid="low-images">
            Low images: {passedCount} passed
          </span>
        )}
      </div>

      {shownWarnings(product).map((warning) => (
        <div key={warning} className="notice notice-warn">{warning}</div>
      ))}

      <div className="results-split">
      <div className="stack">
      <label className="field">
        <span>Category</span>
        <input type="text" value={category} readOnly={readOnly} onChange={(e) => setCategory(e.target.value)} data-testid="review-category" />
        {category.trim() && <span className="pill pill-muted">{category.trim()}</span>}
      </label>
      <label className="field">
        <span>Product name</span>
        <input type="text" value={name} readOnly={readOnly} onChange={(e) => setName(e.target.value)} data-testid="review-name" />
      </label>
      {!readOnly && product.name_options.length > 0 && (
        <div className="row row-wrap" aria-label="Other name options">
          <span className="muted">Other options:</span>
          {[product.name ?? "", ...product.name_options].filter((option) => option && option !== name).map((option) => (
            <button key={option} type="button" className="chip" onClick={() => setName(option)}>
              {option}
            </button>
          ))}
        </div>
      )}

      <label className="field">
        <span>Product description</span>
        <textarea rows={14} value={description} readOnly={readOnly} onChange={(e) => setDescription(e.target.value)} data-testid="review-description" />
        <small className="muted">Lines starting with &quot;- &quot; become bullets.</small>
      </label>
      {product.claims.length > 0 && (
        <div className="notice notice-warn">
          <strong>Needs checking:</strong> confirm these claims are true before publishing, or remove them.
          <ul>{product.claims.map((claim) => <li key={claim}>{claim}</li>)}</ul>
        </div>
      )}
      </div>

      <section className="stack-tight">
        <h3>Images <span className="muted">({imageIds.size} selected)</span></h3>
        {images.length === 0 && <p className="muted">No images were found.</p>}
        <div className="image-grid">
          {images.map((image) => (
            <ImageTile key={image.id} productId={id} image={image} checked={imageIds.has(image.id)} onChange={(on) => toggle(imageIds, setImageIds, image.id, on)} />
          ))}
        </div>
      </section>
      </div>

      {videos.length > 0 && <section>
        <h3>Videos</h3>
        <ul className="video-list">
          {videos.map((video) => (
            <VideoRow key={video.id} productId={id} video={video} checked={videoIds.has(video.id)} onChange={(on) => toggle(videoIds, setVideoIds, video.id, on)} />
          ))}
        </ul>
      </section>}

      <p className="notice">
        Web images and videos may be copyrighted. Use only what you have the right to use.
      </p>

      {error && <p className="error" role="alert">{error}</p>}
      {!readOnly && <div className="row">
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={() =>
            act(() =>
              api(`/api/products/${id}/approve`, {
                json: {
                  name,
                  category,
                  description,
                  imageIds: images.filter((image) => imageIds.has(image.id)).map((image) => image.id),
                  videoIds: videos.filter((video) => videoIds.has(video.id)).map((video) => video.id),
                },
              }),
            )
          }
        >
          Approve to Listing
        </button>
        <button className="btn" disabled={busy} onClick={() => act(() => api(`/api/products/${id}/reject`, { json: {} }))}>
          Reject
        </button>
        <button className="btn" disabled={busy} onClick={() => act(() => api(`/api/products/${id}/research`, { json: {} }))}>
          Search Again
        </button>
      </div>}
    </article>
  );
}

function ImageTile({ productId, image, checked, onChange }: { productId: string; image: ProductImage; checked: boolean; onChange: (on: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const src = image.file_name ? fileUrl(productId, "images", image.file_name) : null;

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className={`image-tile ${image.passed ? "" : "image-tile-failed"}`} data-testid="image-tile" data-passed={image.passed}>
      <div className="image-frame">
        <label className="image-pick">
          <input type="checkbox" checked={checked} disabled={!image.file_name} onChange={(e) => onChange(e.target.checked)} aria-label="Use this image" />
          {src ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src} alt="" loading="lazy" />
          ) : (
            <div className="image-missing">Not downloaded</div>
          )}
        </label>
        {src && (
          <button type="button" className="image-zoom" aria-label="View full size" onClick={() => setOpen(true)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="6" />
              <path d="M16 16l4 4M11 8.5v5M8.5 11h5" />
            </svg>
          </button>
        )}
      </div>
      {image.uploaded && <div className="image-meta"><div className="small muted">Your upload</div></div>}
      {open && src && createPortal(
        <div className="image-lightbox" role="dialog" aria-modal="true" aria-label="Full size image" onClick={() => setOpen(false)}>
          <button type="button" className="image-lightbox-close" aria-label="Close" onClick={() => setOpen(false)}>×</button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt="" onClick={(event) => event.stopPropagation()} />
        </div>,
        document.body,
      )}
    </div>
  );
}

function VideoRow({ productId, video, checked, onChange }: { productId: string; video: ProductVideo; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <li className="video-row" data-testid="video-row" data-kind={video.kind}>
      <input type="checkbox" checked={checked} disabled={video.kind === "file" && !video.file_name} onChange={(e) => onChange(e.target.checked)} aria-label="Use this video" />
      <div>
        <span className="pill pill-muted">{video.kind === "file" ? "File" : `Link: ${video.provider}`}</span>{" "}
        {video.kind === "file" && !video.passed && <span className="pill pill-failed">Failed</span>}
        {video.uploaded && <span className="muted">Your upload </span>}
        {video.url && <a href={safeHref(video.url)} target="_blank" rel="noopener noreferrer nofollow">{shortUrl(video.url)}</a>}
        {video.bytes ? <span className="muted"> {formatBytes(video.bytes)}</span> : null}
        {video.reason && <div className="small reason">{video.reason}</div>}
        {video.file_name && <video className="video-preview" controls preload="none" src={fileUrl(productId, "videos", video.file_name)} />}
      </div>
    </li>
  );
}

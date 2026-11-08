"use client";

import { useEffect, useState } from "react";
import { api, fileUrl, formatBytes, safeHref, shortUrl, usePolling } from "@/components/api";
import type { Job, Product, ProductImage, ProductVideo, Source } from "@/lib/types";

interface Detail {
  product: Product;
  images: ProductImage[];
  videos: ProductVideo[];
  sources: Omit<Source, "text">[];
  job: Job | null;
}

export default function ReviewPage() {
  const { data, refresh } = usePolling<{ products: Product[] }>("/api/products?stages=review,rejected", 3000);
  const products = data?.products ?? [];
  const pending = products.filter((product) => product.stage === "review");
  const rejected = products.filter((product) => product.stage === "rejected");

  return (
    <div className="stack">
      <h1>Review</h1>
      {data && pending.length === 0 && <p className="muted">Nothing to review. Finished research appears here.</p>}
      {pending.map((product) => (
        // updated_at is not in the key, so polling never replaces your unsaved edits.
        <ReviewCard key={product.id} id={product.id} onDone={refresh} />
      ))}
      {rejected.length > 0 && (
        <section className="stack-tight">
          <h2>Rejected</h2>
          {rejected.map((product) => (
            <RejectedRow key={product.id} product={product} onDone={refresh} />
          ))}
        </section>
      )}
    </div>
  );
}

function RejectedRow({ product, onDone }: { product: Product; onDone: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="card row row-between" data-testid="rejected-row">
      <span>{product.name || product.input_name || "Product from your upload"}</span>
      <div className="row">
        {error && <span className="error">{error}</span>}
        <button
          className="btn"
          onClick={() =>
            api(`/api/products/${product.id}/research`, { json: {} })
              .then(onDone)
              .catch((e: Error) => setError(e.message))
          }
        >
          Search Again
        </button>
      </div>
    </div>
  );
}

function ReviewCard({ id, onDone }: { id: string; onDone: () => Promise<void> }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [name, setName] = useState("");
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
        setDescription(body.product.description ?? "");
        setImageIds(new Set(body.images.filter((image) => image.selected).map((image) => image.id)));
        setVideoIds(new Set(body.videos.filter((video) => video.selected).map((video) => video.id)));
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);

  if (!detail) return <div className="card muted">{error ?? "Loading..."}</div>;
  const { product, images, videos, sources } = detail;
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
    <article className="card stack" data-testid="review-card" data-product={id}>
      <div className="row row-between">
        <h2 className="card-title">{product.name}</h2>
        {product.low_images && (
          <span className="pill pill-warn" data-testid="low-images">
            Low images: {passedCount} passed
          </span>
        )}
      </div>

      {product.warnings.map((warning) => (
        <div key={warning} className="notice notice-warn">{warning}</div>
      ))}

      <label className="field">
        <span>Product name</span>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} data-testid="review-name" />
      </label>
      {product.name_options.length > 0 && (
        <div className="row row-wrap" aria-label="Other name options">
          <span className="muted">Other options:</span>
          {[product.name ?? "", ...product.name_options].filter((option) => option && option !== name).map((option) => (
            <button key={option} type="button" className="chip" onClick={() => setName(option)}>
              {option}
            </button>
          ))}
        </div>
      )}

      <div className="two-col">
        <label className="field">
          <span>Rewritten description</span>
          <textarea rows={14} value={description} onChange={(e) => setDescription(e.target.value)} data-testid="review-description" />
          <small className="muted">Lines starting with &quot;- &quot; become bullets.</small>
        </label>
        <div className="field">
          <span>Source text</span>
          <div className="source-text" tabIndex={0}>{product.source_text || "No source text was found."}</div>
        </div>
      </div>

      {product.claims.length > 0 && (
        <div className="notice notice-warn">
          <strong>Needs checking:</strong> confirm these claims are true before publishing, or remove them.
          <ul>{product.claims.map((claim) => <li key={claim}>{claim}</li>)}</ul>
        </div>
      )}

      <section>
        <h3>Images <span className="muted">({imageIds.size} selected, {passedCount} of {images.length} passed)</span></h3>
        {images.length === 0 && <p className="muted">No images were found.</p>}
        <div className="image-grid">
          {images.map((image) => (
            <ImageTile key={image.id} productId={id} image={image} checked={imageIds.has(image.id)} onChange={(on) => toggle(imageIds, setImageIds, image.id, on)} />
          ))}
        </div>
      </section>

      <section>
        <h3>Videos</h3>
        {videos.length === 0 && <p className="muted">No videos were found.</p>}
        <ul className="video-list">
          {videos.map((video) => (
            <VideoRow key={video.id} productId={id} video={video} checked={videoIds.has(video.id)} onChange={(on) => toggle(videoIds, setVideoIds, video.id, on)} />
          ))}
        </ul>
      </section>

      <section>
        <h3>Seller and source pages</h3>
        <p>Seller: <strong>{product.seller_name || "Not found"}</strong></p>
        <ul className="source-list">
          {sources.map((source) => (
            <li key={source.id}>
              <span className={source.status === "accepted" ? "pill pill-done" : "pill pill-muted"}>{source.status === "accepted" ? "Used" : "Dropped"}</span>{" "}
              <a href={safeHref(source.url)} target="_blank" rel="noopener noreferrer nofollow">{shortUrl(source.url)}</a>
              {source.seller && <span className="muted"> ({source.seller})</span>}
              {source.reason && <div className="muted small">{source.reason}</div>}
            </li>
          ))}
        </ul>
      </section>

      <p className="notice">
        Web images and videos may be copyrighted. Use only what you have the right to use.
      </p>

      {error && <p className="error" role="alert">{error}</p>}
      <div className="row">
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={() =>
            act(() =>
              api(`/api/products/${id}/approve`, {
                json: {
                  name,
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
      </div>
    </article>
  );
}

function ImageTile({ productId, image, checked, onChange }: { productId: string; image: ProductImage; checked: boolean; onChange: (on: boolean) => void }) {
  const { checks } = image;
  const results: [string, boolean | undefined][] = [
    ["800x800", checks.minSize],
    ["Not a duplicate", checks.duplicate ? false : image.reason?.startsWith("Too small") ? undefined : true],
    ["Clear", checks.clear],
    ["Correct product", checks.correctProduct],
    ["No watermark", checks.noWatermark],
    ["No other logo", checks.noOtherBrandLogo],
  ];
  return (
    <div className={`image-tile ${image.passed ? "" : "image-tile-failed"}`} data-testid="image-tile" data-passed={image.passed}>
      <label className="image-pick">
        <input type="checkbox" checked={checked} disabled={!image.file_name} onChange={(e) => onChange(e.target.checked)} aria-label="Use this image" />
        {image.file_name ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={fileUrl(productId, "images", image.file_name)} alt={`Candidate ${image.width}x${image.height}`} loading="lazy" />
        ) : (
          <div className="image-missing">Not downloaded</div>
        )}
      </label>
      <div className="image-meta">
        <span className={image.passed ? "pill pill-done" : "pill pill-failed"}>{image.passed ? "Passed" : "Failed"}</span>{" "}
        {image.width ? <span className="muted small">{image.width}x{image.height} {formatBytes(image.bytes)}</span> : null}
        {image.reason && <div className="small reason">{image.reason}</div>}
        <details className="small">
          <summary>Check results</summary>
          <ul className="check-list">
            {results.filter(([, value]) => value !== undefined).map(([label, value]) => (
              <li key={label}>{value ? "Pass" : "Fail"}: {label}</li>
            ))}
            {!checks.aiChecked && <li>Vision check not run</li>}
            {checks.quality !== undefined && <li>Quality: {checks.quality}/100</li>}
          </ul>
        </details>
        {image.uploaded ? (
          <div className="small muted">Your upload</div>
        ) : (
          <div className="small"><a href={safeHref(image.source_page)} target="_blank" rel="noopener noreferrer nofollow">Source page</a></div>
        )}
      </div>
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
        {video.source_page && (
          <span className="small"> from <a href={safeHref(video.source_page)} target="_blank" rel="noopener noreferrer nofollow">source page</a></span>
        )}
        {video.reason && <div className="small reason">{video.reason}</div>}
        {video.file_name && <video className="video-preview" controls preload="none" src={fileUrl(productId, "videos", video.file_name)} />}
      </div>
    </li>
  );
}

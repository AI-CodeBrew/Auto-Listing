"use client";

import { useEffect, useRef, useState } from "react";
import { api, fileUrl, safeHref, shortUrl, usePolling } from "@/components/api";
import type { Product, ProductImage, ProductVideo, ShopifyStatus } from "@/lib/types";

interface Detail {
  product: Product;
  images: ProductImage[];
  videos: ProductVideo[];
}

const STATUS_LABEL: Record<ShopifyStatus, string> = {
  ready: "Ready",
  sending: "Sending",
  draft: "Shopify Draft",
  error: "Error",
};

export default function ListingPage() {
  const { data, refresh } = usePolling<{ products: Product[] }>("/api/products?stages=listing", 1500);
  return (
    <div className="stack">
      <h1>Listing</h1>
      {data && data.products.length === 0 && <p className="muted">No approved products yet. Approve one in the Review tab.</p>}
      {data?.products.map((product) => <ListingCard key={product.id} live={product} onChange={refresh} />)}
    </div>
  );
}

function move<T>(list: T[], index: number, delta: number): T[] {
  const next = [...list];
  const target = index + delta;
  if (target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

function ListingCard({ live, onChange }: { live: Product; onChange: () => Promise<void> }) {
  const id = live.id;
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [cost, setCost] = useState("");
  const [images, setImages] = useState<ProductImage[]>([]);
  const [videos, setVideos] = useState<ProductVideo[]>([]);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const sendingRef = useRef(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Detail>(`/api/products/${id}`)
      .then((body) => {
        setName(body.product.name ?? "");
        setSku(body.product.sku ?? "");
        setDescription(body.product.description ?? "");
        setPrice(body.product.price ?? "");
        setCost(body.product.cost ?? "");
        setImages(body.images.filter((image) => image.selected));
        setVideos(body.videos.filter((video) => video.selected));
        setLoaded(true);
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);

  if (!loaded) return <div className="card muted">{error ?? "Loading..."}</div>;

  const status = live.shopify_status;
  const locked = status === "sending" || status === "draft";
  const edit = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value);
    setDirty(true);
    setSaved(false);
  };
  const priceEmpty = !price.trim();
  const needsChecking = description.includes("[needs checking]");

  async function save(): Promise<boolean> {
    try {
      await api(`/api/products/${id}`, {
        method: "PATCH",
        json: { name, sku, description, price, cost, imageIds: images.map((image) => image.id), videoIds: videos.map((video) => video.id) },
      });
      setDirty(false);
      setError(null);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  async function send() {
    if (sendingRef.current) return; // The server enforces this too. This only stops a pointless request.
    sendingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      if (dirty && !(await save())) return;
      await api(`/api/products/${id}/send`, { json: {} });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      sendingRef.current = false;
      setBusy(false);
      await onChange();
    }
  }

  return (
    <article className="card stack" data-testid="listing-card" data-product={id} data-status={status}>
      <div className="row row-between">
        <h2 className="card-title">{name || "Untitled"}</h2>
        <span className={`pill pill-shopify-${status}`} data-testid="shopify-status">{STATUS_LABEL[status]}</span>
      </div>

      {status === "error" && live.shopify_error && (
        <div className="notice notice-error" role="alert" data-testid="shopify-error">{live.shopify_error}</div>
      )}
      {live.shopify_warnings.map((warning) => (
        <div key={warning} className="notice notice-warn">{warning}</div>
      ))}
      {!locked && priceEmpty && (
        <div className="notice notice-warn" data-testid="price-warning">No selling price set. The draft will be created with price 0.00.</div>
      )}
      {!locked && needsChecking && (
        <div className="notice notice-warn">The description still has &quot;[needs checking]&quot; marks. Confirm or remove those claims before you publish.</div>
      )}

      <fieldset disabled={locked} className="plain-fieldset stack">
        <div className="three-col">
          <label className="field field-wide">
            <span>Name</span>
            <input type="text" value={name} onChange={(e) => edit(setName)(e.target.value)} data-testid="listing-name" />
          </label>
          <label className="field">
            <span>SKU</span>
            <input type="text" value={sku} onChange={(e) => edit(setSku)(e.target.value)} data-testid="listing-sku" />
          </label>
        </div>
        <div className="three-col">
          <label className="field">
            <span>Selling price</span>
            <input type="text" inputMode="decimal" value={price} onChange={(e) => edit(setPrice)(e.target.value)} placeholder="0.00" data-testid="listing-price" />
          </label>
          <label className="field">
            <span>Cost price</span>
            <input type="text" inputMode="decimal" value={cost} onChange={(e) => edit(setCost)(e.target.value)} placeholder="0.00" data-testid="listing-cost" />
          </label>
        </div>
        <label className="field">
          <span>Description</span>
          <textarea rows={8} value={description} onChange={(e) => edit(setDescription)(e.target.value)} data-testid="listing-description" />
          <small className="muted">Lines starting with &quot;- &quot; become bullets.</small>
        </label>

        <section>
          <h3>Images <span className="muted">(the first is the main image)</span></h3>
          {images.length === 0 && <p className="muted">No images selected.</p>}
          <ol className="order-grid">
            {images.map((image, index) => (
              <li key={image.id} className="order-tile" data-testid="listing-image" data-id={image.id}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={fileUrl(id, "images", image.file_name!)} alt={`Image ${index + 1}`} />
                <div className="order-actions">
                  <span className="muted small">{index + 1}</span>
                  <button type="button" className="icon-btn" aria-label={`Move image ${index + 1} earlier`} disabled={index === 0} onClick={() => edit(setImages)(move(images, index, -1))}>&#8592;</button>
                  <button type="button" className="icon-btn" aria-label={`Move image ${index + 1} later`} disabled={index === images.length - 1} onClick={() => edit(setImages)(move(images, index, 1))}>&#8594;</button>
                  <button type="button" className="icon-btn" aria-label={`Remove image ${index + 1}`} onClick={() => edit(setImages)(images.filter((item) => item.id !== image.id))}>&#215;</button>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section>
          <h3>Videos</h3>
          {videos.length === 0 && <p className="muted">No videos selected.</p>}
          <ul className="video-list">
            {videos.map((video, index) => (
              <li key={video.id} className="video-row" data-testid="listing-video" data-kind={video.kind}>
                <div className="order-actions">
                  <button type="button" className="icon-btn" aria-label={`Move video ${index + 1} up`} disabled={index === 0} onClick={() => edit(setVideos)(move(videos, index, -1))}>&#8593;</button>
                  <button type="button" className="icon-btn" aria-label={`Move video ${index + 1} down`} disabled={index === videos.length - 1} onClick={() => edit(setVideos)(move(videos, index, 1))}>&#8595;</button>
                  <button type="button" className="icon-btn" aria-label={`Remove video ${index + 1}`} onClick={() => edit(setVideos)(videos.filter((item) => item.id !== video.id))}>&#215;</button>
                </div>
                <div>
                  <span className="pill pill-muted">{video.kind === "file" ? "File" : `Link: ${video.provider}`}</span>{" "}
                  {video.url ? <a href={safeHref(video.url)} target="_blank" rel="noopener noreferrer nofollow">{shortUrl(video.url)}</a> : <span className="muted">Your upload</span>}
                  {video.kind === "link" && video.provider !== "youtube" && video.provider !== "vimeo" && (
                    <div className="small reason">Shopify can only attach YouTube and Vimeo links, so this one will be left out of the draft.</div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      </fieldset>

      {error && <p className="error" role="alert" data-testid="listing-error">{error}</p>}
      {saved && !error && <p className="muted" role="status">Saved.</p>}

      <div className="row">
        {status === "ready" && (
          <button className="btn btn-primary" disabled={busy} onClick={send} data-testid="send-button">Approve: Send to Shopify Draft</button>
        )}
        {status === "error" && (
          <button className="btn btn-primary" disabled={busy} onClick={send} data-testid="retry-button">Retry</button>
        )}
        {status === "sending" && <button className="btn btn-primary" disabled>Sending...</button>}
        {!locked && (
          <button
            className="btn"
            disabled={!dirty || busy}
            onClick={async () => {
              if (await save()) {
                setSaved(true);
                await onChange();
              }
            }}
          >
            Save changes
          </button>
        )}
        {safeHref(live.shopify_admin_url) && (
          <a className="btn" href={safeHref(live.shopify_admin_url)} target="_blank" rel="noopener noreferrer" data-testid="open-in-shopify">Open in Shopify</a>
        )}
      </div>
    </article>
  );
}

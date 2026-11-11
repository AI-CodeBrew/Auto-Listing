"use client";

import { useEffect, useState } from "react";
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

export default function PushedPage() {
  const { data } = usePolling<{ products: Product[] }>("/api/products?stages=listing", 1500);
  const pushed = data?.products.filter((product) => product.shopify_product_id) ?? [];
  return (
    <div className="page stack">
      <header className="page-head">
        <h1>Pushed to Shopify</h1>
        <p>These drafts are already in Shopify. Open a listing there to change it.</p>
      </header>
      {data && pushed.length === 0 && <p className="muted">Nothing has been pushed yet.</p>}
      {pushed.map((product) => <PushedCard key={product.id} live={product} />)}
    </div>
  );
}

function PushedCard({ live }: { live: Product }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Detail>(`/api/products/${live.id}`)
      .then(setDetail)
      .catch((e: Error) => setError(e.message));
  }, [live.id]);

  const product = detail?.product ?? live;
  const images = detail?.images.filter((image) => image.selected) ?? [];
  const videos = detail?.videos.filter((video) => video.selected) ?? [];
  const status = live.shopify_status;

  return (
    <details className="card listing-fold" data-testid="listing-card" data-product={live.id} data-status={status}>
      <summary>
        <span className="card-title">{product.name || "Untitled"}</span>
        <span className={`pill pill-shopify-${status}`} data-testid="shopify-status">{STATUS_LABEL[status]}</span>
      </summary>
      <div className="listing-body">
        {!detail && <p className="muted">{error ?? "Loading..."}</p>}
        {detail && (
          <>
            {status === "error" && live.shopify_error && (
              <div className="notice notice-error" role="alert" data-testid="shopify-error">{live.shopify_error}</div>
            )}
            {live.shopify_warnings.map((warning) => (
              <div key={warning} className="notice notice-warn">{warning}</div>
            ))}
            <div className="three-col">
              <p className="field"><span>Product name</span>{product.name}</p>
              <p className="field"><span>Category</span>{product.category || "—"}</p>
              <p className="field"><span>SKU</span>{product.sku || "—"}</p>
              <p className="field"><span>Selling price</span>{product.price || "0.00"}</p>
              <p className="field"><span>Cost price</span>{product.cost || "—"}</p>
            </div>
            <p className="field"><span>Description</span><span className="muted">{product.description}</span></p>
            <section>
              <h3>Images</h3>
              {images.length === 0 && <p className="muted">No images.</p>}
              <ol className="order-grid">
                {images.map((image, index) => (
                  <li key={image.id} className="order-tile" data-testid="listing-image" data-id={image.id}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={fileUrl(live.id, "images", image.file_name!)} alt={`Image ${index + 1}`} />
                  </li>
                ))}
              </ol>
            </section>
            {videos.length > 0 && (
              <section>
                <h3>Videos</h3>
                <ul className="video-list">
                  {videos.map((video) => (
                    <li key={video.id} className="video-row" data-testid="listing-video" data-kind={video.kind}>
                      <span className="pill pill-muted">{video.kind === "file" ? "File" : video.provider}</span>{" "}
                      {video.url ? <a href={safeHref(video.url)} target="_blank" rel="noopener noreferrer nofollow">{shortUrl(video.url)}</a> : <span className="muted">Your upload</span>}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {safeHref(live.shopify_admin_url) && (
              <div className="row">
                <a className="btn" href={safeHref(live.shopify_admin_url)} target="_blank" rel="noopener noreferrer" data-testid="open-in-shopify">Open in Shopify</a>
              </div>
            )}
          </>
        )}
      </div>
    </details>
  );
}

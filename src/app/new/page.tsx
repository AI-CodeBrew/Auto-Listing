"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { api, usePolling } from "@/components/api";
import type { Job, ProductStage } from "@/lib/types";

type JobRow = Job & { product_name: string | null; product_stage: ProductStage };

interface Status {
  ai: { ok: boolean; message: string | null };
  shopifyMissing: string[];
}

const STATUS_LABEL: Record<Job["status"], string> = {
  QUEUED: "Queued",
  RUNNING: "Running",
  DONE: "Done",
  BLOCKED: "BLOCKED",
  FAILED: "Failed",
};

export default function NewProductPage() {
  const [name, setName] = useState("");
  const [details, setDetails] = useState("");
  const [urls, setUrls] = useState("");
  const [hasFile, setHasFile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const jobs = usePolling<{ jobs: JobRow[] }>("/api/jobs", 1500);
  const status = usePolling<Status>("/api/status", 10000);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const file = fileRef.current?.files?.[0];
    if (!file && !name.trim()) {
      setError("Enter a product name, or upload an image or video.");
      return;
    }
    const form = new FormData();
    form.append("name", name);
    form.append("details", details);
    form.append("urls", urls);
    if (file) form.append("file", file);
    setSubmitting(true);
    try {
      await api("/api/products", { form });
      setName("");
      setDetails("");
      setUrls("");
      setHasFile(false);
      if (fileRef.current) fileRef.current.value = "";
      void jobs.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="stack">
      {status.data && !status.data.ai.ok && (
        <div className="notice notice-warn" role="status" data-testid="ai-warning">
          <strong>Research cannot run yet.</strong> {status.data.ai.message}
        </div>
      )}
      {status.data && status.data.shopifyMissing.length > 0 && (
        <div className="notice" role="status">
          Shopify is not connected yet. Open the <Link href="/shopify">Shopify tab</Link> and fill in: {status.data.shopifyMissing.join(", ")}.
        </div>
      )}

      <section className="card">
        <h1>New product</h1>
        <p className="muted">Give at least one of: an image, a video, or a product name.</p>
        <form onSubmit={submit} className="form">
          <label className="field">
            <span>Product image or video</span>
            <input ref={fileRef} type="file" name="file" accept="image/*,video/mp4,video/quicktime,video/webm,.mov" onChange={(e) => setHasFile(Boolean(e.target.files?.length))} />
            <small className="muted">Images up to 20 MB. MP4, MOV or WEBM videos up to 1 GB.</small>
          </label>
          <label className="field">
            <span>Product name</span>
            <input type="text" name="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Stainless steel water bottle 750 ml" />
          </label>
          <label className="field">
            <span>Product details (optional)</span>
            <textarea
              name="details"
              rows={4}
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              placeholder="Stainless steel water bottle, 750 ml, leak-proof, matte black. Mention brand, material, size, colors and use."
              data-testid="product-details"
            />
            <small className="muted">The description is written from this first. Leave it empty to rely on the photo and the web.</small>
          </label>
          <label className="field">
            <span>Product page URLs (optional)</span>
            <textarea name="urls" rows={3} value={urls} onChange={(e) => setUrls(e.target.value)} placeholder={"One per line\nhttps://example-store.com/products/water-bottle"} />
          </label>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="row">
            <button className="btn btn-primary" type="submit" disabled={submitting || (!hasFile && !name.trim())}>
              {submitting ? "Uploading..." : "Start research"}
            </button>
          </div>
        </form>
      </section>

      <section className="stack-tight" aria-live="polite">
        <h2>Research jobs</h2>
        {jobs.error && <p className="error">{jobs.error}</p>}
        {jobs.data && jobs.data.jobs.length === 0 && <p className="muted">No jobs yet. Jobs run one at a time and carry on after a restart.</p>}
        {jobs.data?.jobs.map((job, index, all) => (
          // Jobs arrive newest first, so the first row for a product is its current one.
          <JobCard key={job.id} job={job} isCurrent={all.findIndex((other) => other.product_id === job.product_id) === index} onChange={jobs.refresh} />
        ))}
      </section>
    </div>
  );
}

function JobCard({ job, isCurrent, onChange }: { job: JobRow; isCurrent: boolean; onChange: () => Promise<void> }) {
  const [urls, setUrls] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const title = job.product_name || "Product from your upload";
  // Older rows for a product are history, so only the current one offers actions.
  const canAct = isCurrent && job.product_stage === job.status.toLowerCase();

  async function rerun(pasted?: string) {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/products/${job.product_id}/research`, { json: { urls: pasted } });
      setUrls("");
      await onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="card job" data-testid="job" data-status={job.status}>
      <div className="row row-between">
        <strong>{title}</strong>
        <span className={`pill pill-${job.status.toLowerCase()}`}>{STATUS_LABEL[job.status]}</span>
      </div>
      <p className="muted job-step">{job.step}</p>

      {job.status === "BLOCKED" && (
        <div className="notice notice-warn">
          <p role="alert">{job.message}</p>
          {canAct && (
            <>
              <label className="field">
                <span>Product page URLs</span>
                <textarea rows={3} value={urls} onChange={(e) => setUrls(e.target.value)} placeholder="One per line" data-testid="blocked-urls" />
              </label>
              <button className="btn btn-primary" disabled={busy || !urls.trim()} onClick={() => rerun(urls)}>
                Continue with these URLs
              </button>
            </>
          )}
        </div>
      )}
      {job.status === "FAILED" && (
        <div className="notice notice-error">
          <p role="alert">{job.message}</p>
          {canAct && (
            <button className="btn" disabled={busy} onClick={() => rerun()}>
              Try again
            </button>
          )}
        </div>
      )}
      {job.status === "DONE" && job.product_stage === "review" && <Link href="/review">Open in Review</Link>}
      {error && <p className="error" role="alert">{error}</p>}
      {job.log.length > 0 && (
        <details className="job-log">
          <summary>Steps ({job.log.length})</summary>
          <ol>
            {job.log.map((entry, index) => (
              <li key={index}>{entry.text}</li>
            ))}
          </ol>
        </details>
      )}
    </article>
  );
}

"use client";

import Link from "next/link";
import { useState } from "react";
import { api, usePolling } from "@/components/api";
import { money } from "@/lib/costs";
import type { Job, ProductStage, RequestCost } from "@/lib/types";

type JobRow = Job & { product_name: string | null; product_stage: ProductStage; search_photos: boolean; search_videos: boolean; cost: RequestCost };

const STATUS_LABEL: Record<Job["status"], string> = {
  QUEUED: "Queued",
  RUNNING: "Running",
  DONE: "Done",
  BLOCKED: "Blocked",
  FAILED: "Failed",
};

export function JobList() {
  const jobs = usePolling<{ jobs: JobRow[] }>("/api/jobs", 1500);

  return (
    <div className="stack" aria-live="polite">
      {jobs.error && <p className="error">{jobs.error}</p>}
      {jobs.data && jobs.data.jobs.length === 0 && <p className="muted">No requests yet.</p>}
      {jobs.data?.jobs.map((job, index, all) => (
        <JobCard key={job.id} job={job} isCurrent={all.findIndex((other) => other.product_id === job.product_id) === index} onChange={jobs.refresh} />
      ))}
    </div>
  );
}

function JobCard({ job, isCurrent, onChange }: { job: JobRow; isCurrent: boolean; onChange: () => Promise<void> }) {
  const [urls, setUrls] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const title = job.product_name || "Product from your upload";
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
    <article className="job" data-testid="job" data-status={job.status}>
      <div className="row row-between">
        <strong>{title}</strong>
        <span className="row">
          <span className="muted small">{money(job.cost.aiUsd)}</span>
          <span className={`pill pill-${job.status.toLowerCase()}`}>{STATUS_LABEL[job.status]}</span>
        </span>
      </div>
      <p className="job-step">{job.step}</p>

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
      {job.status === "DONE" && job.product_stage === "review" && <Link href="/review">Open results</Link>}
      {error && <p className="error" role="alert">{error}</p>}
      {job.log.length > 0 && (
        <details className="job-log">
          <summary>Steps</summary>
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

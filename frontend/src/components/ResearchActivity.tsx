"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { usePolling } from "@/components/api";
import type { Job, Product } from "@/lib/types";

interface Detail {
  product: Product;
  job: Job | null;
}

/** Live search trace. The current step stays in view, the same way a chat shows work in progress. */
export function ResearchActivity({ productId, initialJob = null }: { productId: string; initialJob?: Job | null }) {
  const { data, error } = usePolling<Detail>(`/api/products/${productId}`, 1000);
  const job = data?.job ?? initialJob;
  const running = !job || job.status === "QUEUED" || job.status === "RUNNING";
  const log = job?.log ?? [];
  const current = job?.step || "Starting the search";
  const endRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [log.length, current]);

  const title =
    job?.status === "DONE"
      ? "Search finished"
      : job?.status === "BLOCKED"
        ? "Needs a product page"
        : job?.status === "FAILED"
          ? "Search stopped"
          : "Searching";

  return (
    <section className="activity" aria-live="polite" data-testid="research-activity">
      <div className="activity-live">
        <span className={running ? "activity-pulse" : "activity-mark"} aria-hidden="true" />
        <div>
          <strong>{title}</strong>
          {running && <p className="activity-now">{current}</p>}
        </div>
      </div>
      {log.length > 0 && (
        <ol className="activity-log">
          {log.map((entry, index) => (
            <li key={`${entry.at}-${index}`} ref={index === log.length - 1 ? endRef : undefined}>
              {entry.text}
            </li>
          ))}
        </ol>
      )}
      {job?.status === "FAILED" && job.message && <p className="error">{job.message}</p>}
      {job?.status === "BLOCKED" && job.message && <p className="notice notice-warn">{job.message}</p>}
      {job?.status === "DONE" && (
        <Link className="btn btn-primary" href="/review">
          Open the result
        </Link>
      )}
      {job?.status === "BLOCKED" && (
        <Link className="btn" href="/review">
          Add product page URLs
        </Link>
      )}
      {error && error !== "Product not found" && <p className="error">{error}</p>}
    </section>
  );
}

"use client";

import { useState } from "react";
import { money } from "@/lib/costs";
import type { SerpPlan } from "@/lib/types";
import type { Job, ProductStage, RequestCost } from "@/lib/types";

type JobRow = Job & {
  product_name: string | null;
  product_stage: ProductStage;
  search_photos: boolean;
  search_videos: boolean;
  cost: RequestCost;
};

const TABS = [
  { id: "estimate", label: "Estimate" },
  { id: "requests", label: "Requests" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function RequestCost({
  searchPhotos,
  hasUpload,
  jobs,
  serpapi,
  serpPlan,
}: {
  searchPhotos: boolean;
  searchVideos: boolean;
  /** True when the form has a photo. A photo uses one Google Lens search. */
  hasUpload: boolean;
  jobs: JobRow[];
  serpapi: boolean;
  serpPlan: SerpPlan | null;
  fastmoss: boolean;
  model: string;
}) {
  const [tab, setTab] = useState<TabId>("estimate");
  const photoSearches = searchPhotos && serpapi ? (hasUpload ? 1 : 2) : 0;

  return (
    <aside className="card cost-side" aria-label="Request cost">
      <h2>Cost</h2>
      <div className="side-tabs" role="tablist" aria-label="Cost">
        {TABS.map((item) => (
          <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? "side-tab side-tab-on" : "side-tab"} onClick={() => setTab(item.id)}>
            {item.label}
          </button>
        ))}
      </div>

      {tab === "estimate" && (
        <div className="stack-tight" role="tabpanel">
          <ul className="cost-lines">
            <li>
              <span>This request</span>
              <strong>{photoSearches ? `${photoSearches} free search${photoSearches === 1 ? "" : "es"}` : "0 searches"}</strong>
            </li>
            <li>
              <span>Left</span>
              <strong>{serpPlan ? serpPlan.searchesLeft : "—"}</strong>
            </li>
            <li>
              <span>Used</span>
              <strong>{serpPlan ? serpPlan.thisMonthUsage : "—"}</strong>
            </li>
          </ul>
        </div>
      )}

      {tab === "requests" && (
        <div className="stack-tight" role="tabpanel">
          {jobs.length === 0 && <p className="muted small">No requests yet.</p>}
          {jobs.map((job) => (
            <article key={job.id} className="cost-request">
              <div className="row row-between">
                <span>{job.product_name || "Product"}</span>
                <strong>{money(job.cost.totalUsd)}</strong>
              </div>
            </article>
          ))}
        </div>
      )}
    </aside>
  );
}

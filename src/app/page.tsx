"use client";

import Link from "next/link";
import { usePolling } from "@/components/api";
import { SerpKeys } from "@/components/SerpKeys";
import { money } from "@/lib/costs";
import type { RequestCost } from "@/lib/types";

interface Status {
  counts: Record<string, number>;
  listing: { approved: number; pushed: number };
  totals: { requests: number; shopifyDrafts: number; cost: RequestCost };
  recentGpt: { id: string; name: string; aiUsd: number }[];
}

export default function DashboardPage() {
  const { data } = usePolling<Status>("/api/status", 2000);
  const counts = data?.counts ?? {};
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const running = (counts.researching ?? 0) + (counts.blocked ?? 0);
  const n = (value: number) => (data ? value : "—");

  const cards = [
    { label: "To review", value: n(counts.review ?? 0), href: "/review" },
    { label: "Approved", value: n(data?.listing.approved ?? 0), href: "/listing" },
    { label: "Pushed to Shopify", value: n(data?.listing.pushed ?? 0), href: "/pushed" },
    { label: "Rejected", value: n(counts.rejected ?? 0), href: "/review" },
    { label: "In progress", value: n(running), href: "/review" },
    { label: "Total", value: n(total) },
  ];

  return (
    <div className="page stack">
      <header className="page-head">
        <h1>Dashboard</h1>
      </header>

      <SerpKeys note={false} />

      <section className="card stack">
        <h2>GPT cost</h2>
        <div className="gpt-cost-row">
          <ul className="gpt-recent">
            {(data?.recentGpt ?? []).map((item) => (
              <li key={item.id}>
                <strong>{money(item.aiUsd)}</strong>
                <span>{item.name}</span>
              </li>
            ))}
          </ul>
          <div className="gpt-cost-total">
            <p className="dash-figure">{data ? money(data.totals.cost.aiUsd) : "—"}</p>
            <p className="muted">{n(data?.totals.requests ?? 0)} requests</p>
          </div>
        </div>
      </section>

      <section className="card stack">
        <h2>Results</h2>
        <div className="stat-grid">
          {cards.map((card) => {
            const body = (
              <>
                <span>{card.label}</span>
                <strong>{card.value}</strong>
              </>
            );
            return card.href ? (
              <Link key={card.label} href={card.href} className="stat-card">
                {body}
              </Link>
            ) : (
              <div key={card.label} className="stat-card">
                {body}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

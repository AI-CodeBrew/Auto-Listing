"use client";

import Link from "next/link";
import { usePolling } from "@/components/api";
import { SerpKeys } from "@/components/SerpKeys";
import { money } from "@/lib/costs";
import type { RequestCost } from "@/lib/types";

interface Overview {
  accounts: { users: number; activeUsers: number; searchesUsed: number; searchesLeft: number; pendingRequests: number; approvedRequests: number };
  app: { requests: number; shopifyDrafts: number; cost: RequestCost; counts: Record<string, number> };
  ai: { ok: boolean; message: string | null };
  model: string;
  provider: string;
}

export default function AdminOverviewPage() {
  const { data, error } = usePolling<Overview>("/api/admin/overview", 10000);
  const n = (value: number | undefined) => (data ? (value ?? 0) : "—");
  const cards = [
    { label: "Users", value: n(data?.accounts.users), href: "/admin/users" },
    { label: "Active users", value: n(data?.accounts.activeUsers), href: "/admin/users" },
    { label: "Requests waiting", value: n(data?.accounts.pendingRequests), href: "/admin/billing" },
    { label: "Plans approved", value: n(data?.accounts.approvedRequests), href: "/admin/billing" },
    { label: "Searches used by users", value: n(data?.accounts.searchesUsed) },
    { label: "Searches users have left", value: n(data?.accounts.searchesLeft) },
  ];
  const appCards = [
    { label: "All research requests", value: n(data?.app.requests) },
    { label: "Shopify drafts", value: n(data?.app.shopifyDrafts) },
    { label: "In review", value: n(data?.app.counts.review) },
    { label: "Approved listings", value: n(data?.app.counts.listing) },
  ];

  return (
    <div className="page stack">
      <header className="page-head">
        <h1>Admin overview</h1>
        <p>Every account, every plan request and the SerpAPI keys in one place.</p>
      </header>
      {error && <p className="error">{error}</p>}
      {data && !data.ai.ok && (
        <div className="notice notice-warn" role="status">
          <strong>Research cannot run.</strong> {data.ai.message}
        </div>
      )}

      <section className="card stack">
        <h2>Accounts</h2>
        <div className="stat-grid">
          {cards.map((card) =>
            card.href ? (
              <Link key={card.label} href={card.href} className="stat-card">
                <span>{card.label}</span>
                <strong>{card.value}</strong>
              </Link>
            ) : (
              <div key={card.label} className="stat-card">
                <span>{card.label}</span>
                <strong>{card.value}</strong>
              </div>
            ),
          )}
        </div>
      </section>

      <SerpKeys controls />

      <section className="card stack">
        <div className="row row-between">
          <h2>The whole app</h2>
          <span className="muted small">
            AI: {data?.provider === "openai" ? "OpenAI" : "Claude"} {data?.model}
          </span>
        </div>
        <div className="stat-grid">
          {appCards.map((card) => (
            <div key={card.label} className="stat-card">
              <span>{card.label}</span>
              <strong>{card.value}</strong>
            </div>
          ))}
          <div className="stat-card">
            <span>AI cost so far</span>
            <strong>{data ? money(data.app.cost.aiUsd) : "—"}</strong>
          </div>
        </div>
      </section>
    </div>
  );
}

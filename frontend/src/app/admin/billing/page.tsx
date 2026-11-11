"use client";

import { useState } from "react";
import { api, usePolling } from "@/components/api";

interface BillingRequest {
  id: string;
  userEmail: string;
  userName: string;
  planName: string;
  price: string;
  searchesRequested: number;
  searchesGranted: number | null;
  paymentNote: string;
  status: "pending" | "approved" | "rejected";
  adminNote: string | null;
  createdAt: string;
  decidedAt: string | null;
}

const FILTERS = [
  { id: "pending", label: "Waiting" },
  { id: "approved", label: "Approved" },
  { id: "rejected", label: "Rejected" },
  { id: "", label: "All" },
] as const;

const STATUS_PILL = { pending: "pill pill-warn", approved: "pill pill-done", rejected: "pill pill-failed" } as const;

export default function AdminBillingPage() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("pending");
  const { data, error, refresh } = usePolling<{ requests: BillingRequest[] }>(`/api/admin/billing${filter ? `?status=${filter}` : ""}`, 10000);

  return (
    <div className="page stack">
      <header className="page-head">
        <h1>Billing requests</h1>
        <p>Users ask for a plan here. Check their payment, then approve and choose how many searches to give.</p>
      </header>
      <div className="side-tabs" role="tablist" aria-label="Show">
        {FILTERS.map((item) => (
          <button key={item.label} type="button" role="tab" aria-selected={filter === item.id} className={filter === item.id ? "side-tab side-tab-on" : "side-tab"} onClick={() => setFilter(item.id)}>
            {item.label}
          </button>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
      {data && data.requests.length === 0 && <p className="card muted">Nothing here.</p>}
      <div className="stack">
        {(data?.requests ?? []).map((item) => (
          <RequestCard key={item.id} item={item} onDecided={refresh} />
        ))}
      </div>
    </div>
  );
}

function RequestCard({ item, onDecided }: { item: BillingRequest; onDecided: () => Promise<void> }) {
  const [searches, setSearches] = useState(String(item.searchesRequested));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(approve: boolean) {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/admin/billing/${item.id}`, { json: { approve, searches: approve ? Number(searches) : undefined, note } });
      await onDecided();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="card stack" data-testid={`request-${item.userEmail}`}>
      <div className="row row-between row-wrap">
        <div className="stack-tight">
          <strong>
            {item.userName} <span className="muted small">{item.userEmail}</span>
          </strong>
          <span>
            {item.planName} plan · {item.price} · {item.searchesRequested} searches
          </span>
          <span className="muted small">Asked {new Date(item.createdAt).toLocaleString()}</span>
        </div>
        <span className={STATUS_PILL[item.status]}>{item.status}</span>
      </div>
      <div className="stack-tight">
        <span className="muted small">Payment details from the user</span>
        <p>{item.paymentNote || <span className="muted">The user wrote nothing.</span>}</p>
      </div>
      {item.status === "pending" ? (
        <div className="stack">
          <div className="two-col">
            <label className="field">
              <span>Searches to give</span>
              <input type="number" min={1} value={searches} onChange={(e) => setSearches(e.target.value)} />
            </label>
            <label className="field">
              <span>Note for the user (optional)</span>
              <input type="text" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
            </label>
          </div>
          <div className="row">
            <button type="button" className="btn btn-primary" disabled={busy || !(Number(searches) > 0)} onClick={() => void decide(true)}>
              Approve and give {Number(searches) > 0 ? Number(searches) : ""} searches
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => void decide(false)}>
              Reject
            </button>
          </div>
          {error && <p className="error" role="alert">{error}</p>}
        </div>
      ) : (
        <p className="muted small">
          {item.status === "approved" ? `Gave ${item.searchesGranted} searches` : "Rejected"}
          {item.decidedAt ? ` on ${new Date(item.decidedAt).toLocaleString()}` : ""}
          {item.adminNote ? ` · "${item.adminNote}"` : ""}
        </p>
      )}
    </article>
  );
}

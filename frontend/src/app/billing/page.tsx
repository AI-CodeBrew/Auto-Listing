"use client";

import { useState } from "react";
import { api, usePolling } from "@/components/api";

interface Plan {
  id: string;
  name: string;
  price: string;
  searches: number;
  stores: number;
  description: string;
}

interface BillingRequest {
  id: string;
  planName: string;
  price: string;
  searchesRequested: number;
  searchesGranted: number | null;
  paymentNote: string;
  status: "pending" | "approved" | "rejected";
  adminNote: string | null;
  createdAt: string;
}

interface Billing {
  plans: Plan[];
  requests: BillingRequest[];
  user: { searchesLeft: number; searchesAllowed: number; searchesUsed: number; planId: string | null };
}

const STATUS_PILL = { pending: "pill pill-warn", approved: "pill pill-done", rejected: "pill pill-failed" } as const;

export default function BillingPage() {
  const { data, error, refresh } = usePolling<Billing>("/api/billing", 15000);
  const [chosen, setChosen] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const pending = data?.requests.find((item) => item.status === "pending");

  async function send() {
    if (!chosen) return;
    setBusy(true);
    setSaveError(null);
    setMessage(null);
    try {
      await api("/api/billing/request", { json: { planId: chosen, paymentNote: note } });
      setMessage("Request sent. The admin will check it and add your searches.");
      setChosen(null);
      setNote("");
      await refresh();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page stack">
      <header className="page-head">
        <h1>Billing</h1>
        <p>Choose a plan. The admin checks your payment and adds the searches to your account.</p>
      </header>

      {error && <p className="error">{error}</p>}

      <section className="card row row-between row-wrap" data-testid="billing-balance">
        <div className="stack-tight">
          <span className="muted">Searches left</span>
          <strong className="dash-figure">{data ? data.user.searchesLeft : "—"}</strong>
        </div>
        <p className="muted">One search is one product sent for research.</p>
      </section>

      {pending && (
        <div className="notice notice-warn" role="status">
          <strong>Waiting for the admin.</strong> You asked for the {pending.planName} plan ({pending.searchesRequested} searches). You can ask for another plan after this one is decided.
        </div>
      )}

      <div className="plan-grid">
        {(data?.plans ?? []).map((plan, index) => {
          const selected = chosen === plan.id;
          return (
            <article key={plan.id} className={selected ? "card plan-card plan-card-on" : "card plan-card"} data-testid={`plan-${plan.id}`}>
              {index === 1 && <span className="pill pill-running plan-badge">Most popular</span>}
              <h2>{plan.name}</h2>
              <p className="plan-price">{plan.price}</p>
              <p className="plan-searches">
                <strong>{plan.searches}</strong> searches
              </p>
              <p className="plan-searches" data-testid={`plan-stores-${plan.id}`}>
                <strong>{plan.stores}</strong> Shopify {plan.stores === 1 ? "store" : "stores"}
              </p>
              <p className="muted">{plan.description}</p>
              <button type="button" className={selected ? "btn btn-primary" : "btn"} disabled={Boolean(pending) || busy} onClick={() => setChosen(plan.id)} aria-pressed={selected}>
                {selected ? "Selected" : "Choose"}
              </button>
            </article>
          );
        })}
      </div>

      {chosen && !pending && (
        <section className="card stack">
          <h2>Send your request</h2>
          <label className="field">
            <span>Payment details</span>
            <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: paid by JazzCash, transaction ID 123456" maxLength={500} />
            <small className="muted">How and when you paid, so the admin can find it.</small>
          </label>
          <div className="row">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void send()}>
              {busy ? "Sending..." : "Send request to admin"}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setChosen(null)}>
              Cancel
            </button>
          </div>
        </section>
      )}
      {message && <p className="notice" role="status">{message}</p>}
      {saveError && <p className="error" role="alert">{saveError}</p>}

      <section className="card stack">
        <h2>Your requests</h2>
        {data && data.requests.length === 0 && <p className="muted">No requests yet.</p>}
        {data && data.requests.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Plan</th>
                  <th>Searches</th>
                  <th>Status</th>
                  <th>Note from admin</th>
                </tr>
              </thead>
              <tbody>
                {data.requests.map((item) => (
                  <tr key={item.id}>
                    <td>{new Date(item.createdAt).toLocaleDateString()}</td>
                    <td>
                      {item.planName} <span className="muted small">{item.price}</span>
                    </td>
                    <td>{item.status === "approved" ? item.searchesGranted : item.searchesRequested}</td>
                    <td>
                      <span className={STATUS_PILL[item.status]}>{item.status}</span>
                    </td>
                    <td>{item.adminNote || <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

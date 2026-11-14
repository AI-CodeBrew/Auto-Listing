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
  active: boolean;
}

export default function AdminPlansPage() {
  const { data, error, refresh } = usePolling<{ plans: Plan[] }>("/api/admin/plans", 60000);
  return (
    <div className="page stack">
      <header className="page-head">
        <h1>Plans</h1>
        <p>The three plans users see on their Billing page. Change the name, price, number of searches or number of Shopify stores.</p>
      </header>
      {error && <p className="error">{error}</p>}
      <div className="plan-grid">
        {(data?.plans ?? []).map((plan) => (
          <PlanEditor key={`${plan.id}:${plan.name}:${plan.price}:${plan.searches}:${plan.stores}:${plan.description}:${plan.active}`} plan={plan} onSaved={refresh} />
        ))}
      </div>
    </div>
  );
}

function PlanEditor({ plan, onSaved }: { plan: Plan; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState({ ...plan, searches: String(plan.searches), stores: String(plan.stores) });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api(`/api/admin/plans/${plan.id}`, { method: "PUT", json: { ...form, searches: Number(form.searches), stores: Number(form.stores) } });
      setMessage("Saved.");
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="card stack" data-testid={`plan-editor-${plan.id}`}>
      <label className="field">
        <span>Name</span>
        <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={60} />
      </label>
      <label className="field">
        <span>Price</span>
        <input type="text" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} maxLength={60} />
      </label>
      <label className="field">
        <span>Searches</span>
        <input type="number" min={1} value={form.searches} onChange={(e) => setForm({ ...form, searches: e.target.value })} />
      </label>
      <label className="field">
        <span>Stores</span>
        <input type="number" min={1} value={form.stores} onChange={(e) => setForm({ ...form, stores: e.target.value })} data-testid={`plan-stores-${plan.id}`} />
      </label>
      <label className="field">
        <span>Description</span>
        <textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={300} />
      </label>
      <label className="row">
        <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
        Show this plan to users
      </label>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>
        {busy ? "Saving..." : "Save"}
      </button>
      {message && <p className="muted small">{message}</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </article>
  );
}

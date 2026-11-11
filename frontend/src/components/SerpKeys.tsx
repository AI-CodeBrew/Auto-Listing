"use client";

import { useState } from "react";
import { api, usePolling } from "@/components/api";
import type { SerpPlan } from "@/lib/types";

interface KeyView {
  id: 1 | 2;
  configured: boolean;
  active: boolean;
  plan: SerpPlan | null;
}

interface Overview {
  active: 1 | 2;
  auto: boolean;
  keys: KeyView[];
}

const LOW_LEFT = 25;

export function SerpKeys({ controls = false, note = true }: { controls?: boolean; note?: boolean }) {
  const { data, error, refresh } = usePolling<Overview>("/api/settings/serpapi", 15000);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function save(body: { active?: 1 | 2; auto?: boolean }) {
    setBusy(true);
    setSaveError(null);
    try {
      await api("/api/settings/serpapi", { method: "PUT", json: body });
      await refresh();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack" data-testid="serp-keys">
      <div className="row row-between">
        <h2>SerpAPI</h2>
        <button
          type="button"
          className={data?.auto ? "auto-switch auto-switch-on" : "auto-switch"}
          role="switch"
          aria-checked={Boolean(data?.auto)}
          aria-label="Automatic key switch"
          disabled={!data || busy}
          onClick={() => data && save({ auto: !data.auto })}
        >
          <span className="auto-switch-knob" aria-hidden="true" />
          {data?.auto ? "Auto" : "Manual"}
        </button>
      </div>
      {note && <p className="muted">Both keys stay in backend/.env. This shows how much of the free plan each one has used.</p>}
      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">Loading...</p>}
      <div className="stack">
        {data?.keys.map((key) => (
          <KeyBar key={key.id} item={key} manual={data?.auto === false} busy={busy} onUse={() => save({ active: key.id })} />
        ))}
      </div>
      {controls && (
        <p className="muted small">{data?.auto ? "The other key is used when this one reaches its free limit." : "Pick the key yourself. Nothing changes until you press Use this key."}</p>
      )}
      {saveError && <p className="error" role="alert">{saveError}</p>}
    </section>
  );
}

function KeyBar({ item, manual, busy, onUse }: { item: KeyView; manual: boolean; busy: boolean; onUse: () => void }) {
  const plan = item.plan;
  const total = plan ? plan.searchesPerMonth || plan.thisMonthUsage + plan.searchesLeft : 0;
  const used = plan?.thisMonthUsage ?? 0;
  const width = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const empty = plan ? plan.searchesLeft <= 0 : false;
  const low = plan ? plan.searchesLeft > 0 && plan.searchesLeft <= LOW_LEFT : false;

  return (
    <article className="usage-key">
      <div className="row row-between">
        <strong>Key {item.id}</strong>
        <span className="row">
          {item.active && <span className="pill pill-done">Active</span>}
          {!item.configured && <span className="pill pill-muted">Not set</span>}
          {empty && item.configured && <span className="pill pill-failed">Limit reached</span>}
          {low && <span className="pill pill-warn">Close to the limit</span>}
        </span>
      </div>
      {item.configured && plan && (
        <>
          <div className="usage-track" aria-hidden="true">
            <div className={empty ? "usage-fill usage-fill-empty" : low ? "usage-fill usage-fill-low" : "usage-fill"} style={{ width: `${width}%` }} />
          </div>
          <p className="muted small">{used} used · {plan.searchesLeft} left{total ? ` of ${total}` : ""}</p>
        </>
      )}
      {item.configured && !plan && <p className="muted small">Allowance could not be read yet.</p>}
      {!item.configured && <p className="muted small">{item.id === 1 ? "Add SERPAPI_API_KEY" : "Add SERPAPI_API_KEY_2"} in backend/.env and restart the backend.</p>}
      {manual && item.configured && !item.active && (
        <button className="btn" type="button" disabled={busy || empty} onClick={onUse}>
          Use this key
        </button>
      )}
    </article>
  );
}

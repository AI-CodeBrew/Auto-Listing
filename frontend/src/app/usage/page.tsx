"use client";

import Link from "next/link";
import { usePolling } from "@/components/api";
import { useSession } from "@/components/session";
import { SerpKeys } from "@/components/SerpKeys";

interface Account {
  user: { searchesAllowed: number | null; searchesUsed: number | null; searchesLeft: number | null; unlimited?: boolean };
  history: { change: number; reason: string; created_at: string }[];
}

export default function UsagePage() {
  const { session } = useSession();
  if (session?.role === "admin") {
    return (
      <div className="page">
        <header className="page-head">
          <h1>Usage</h1>
          <p>SerpAPI searches used and still left on each free key.</p>
        </header>
        <SerpKeys />
      </div>
    );
  }
  return <UserUsage />;
}

function UserUsage() {
  const { data, error } = usePolling<Account>("/api/account", 10000);
  const user = data?.user;
  const total = user?.searchesAllowed ?? 0;
  const left = user?.searchesLeft ?? 0;
  const width = total > 0 ? Math.round((left / total) * 100) : 0;

  return (
    <div className="page stack">
      <header className="page-head">
        <h1>Usage</h1>
        <p>How many searches you have left. One search is one product sent for research.</p>
      </header>
      {error && <p className="error">{error}</p>}
      <section className="card stack" data-testid="user-usage">
        <div className="row row-between">
          <h2>Searches left</h2>
          {user && left === 0 && <span className="pill pill-failed">None left</span>}
        </div>
        <p className="dash-figure" data-testid="usage-left">{user ? left : "—"}</p>
        <div className="usage-track" aria-hidden="true">
          <div className={left === 0 ? "usage-fill usage-fill-empty" : left <= 2 ? "usage-fill usage-fill-low" : "usage-fill"} style={{ width: `${width}%` }} />
        </div>
        {user && left <= 2 && (
          <p>
            Need more? <Link href="/billing">Choose a plan</Link>.
          </p>
        )}
      </section>
      <section className="card stack">
        <h2>History</h2>
        {data && data.history.length === 0 && <p className="muted">Nothing yet.</p>}
        <ul className="history-list">
          {(data?.history ?? []).map((item, index) => (
            <li key={index} className="row row-between">
              <span>{item.reason}</span>
              <span className="row">
                <strong className={item.change < 0 ? "history-minus" : "history-plus"}>{item.change > 0 ? `+${item.change}` : item.change}</strong>
                <span className="muted small">{new Date(item.created_at).toLocaleString()}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

"use client";

import { useState } from "react";
import { api, usePolling } from "@/components/api";

interface User {
  id: string;
  email: string;
  name: string;
  status: "active" | "blocked";
  searchesAllowed: number;
  searchesUsed: number;
  searchesLeft: number;
  planId: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  products: number;
}

export default function AdminUsersPage() {
  const { data, error, refresh } = usePolling<{ users: User[] }>("/api/admin/users", 15000);
  const [query, setQuery] = useState("");
  const users = (data?.users ?? []).filter((user) => `${user.name} ${user.email}`.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div className="page stack">
      <header className="page-head">
        <h1>Users</h1>
        <p>Everyone who signed up. Give or take searches, or block an account.</p>
      </header>
      {error && <p className="error">{error}</p>}
      <section className="card stack">
        <div className="row row-between row-wrap">
          <h2>{data ? `${data.users.length} user${data.users.length === 1 ? "" : "s"}` : "Users"}</h2>
          <input type="text" placeholder="Search by name or email" value={query} onChange={(e) => setQuery(e.target.value)} className="search-input" aria-label="Search users" />
        </div>
        {data && users.length === 0 && <p className="muted">No users found.</p>}
        {users.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Searches left</th>
                  <th>Used / total</th>
                  <th>Products</th>
                  <th>Plan</th>
                  <th>Status</th>
                  <th>Change searches</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <UserRow key={user.id} user={user} onChanged={refresh} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function UserRow({ user, onChanged }: { user: User; onChanged: () => Promise<void> }) {
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/admin/users/${user.id}`, { method: "PATCH", json: body });
      setAmount("");
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr data-testid={`user-${user.email}`}>
      <td>
        <strong>{user.name}</strong>
        <div className="muted small">{user.email}</div>
        <div className="muted small">Joined {new Date(user.createdAt).toLocaleDateString()}</div>
      </td>
      <td>
        <strong>{user.searchesLeft}</strong>
      </td>
      <td>
        {user.searchesUsed} / {user.searchesAllowed}
      </td>
      <td>{user.products}</td>
      <td>{user.planId ?? <span className="muted">Free</span>}</td>
      <td>
        <span className={user.status === "active" ? "pill pill-done" : "pill pill-failed"}>{user.status}</span>
      </td>
      <td>
        <div className="row">
          <input
            type="number"
            className="number-input"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="+10"
            aria-label={`Searches to add for ${user.email}`}
          />
          <button type="button" className="btn" disabled={busy || !amount.trim()} onClick={() => void change({ addSearches: Number(amount) })}>
            Add
          </button>
        </div>
        {error && <p className="error small">{error}</p>}
      </td>
      <td>
        <button type="button" className="btn" disabled={busy} onClick={() => void change({ status: user.status === "active" ? "blocked" : "active" })}>
          {user.status === "active" ? "Block" : "Unblock"}
        </button>
      </td>
    </tr>
  );
}

"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "./api";

type Mode = "login" | "signup" | "admin";

const TEXT: Record<Mode, { title: string; lead: string; button: string; busy: string; endpoint: string }> = {
  login: { title: "Log in", lead: "Welcome back. Log in to list your products.", button: "Log in", busy: "Logging in...", endpoint: "/api/auth/login" },
  signup: { title: "Create your account", lead: "Sign up free. You get 2 free searches to try the app.", button: "Sign up", busy: "Creating your account...", endpoint: "/api/auth/signup" },
  admin: { title: "Admin login", lead: "Only the admin can log in here.", button: "Log in as admin", busy: "Logging in...", endpoint: "/api/admin/login" },
};

export function AuthForm({ mode }: { mode: Mode }) {
  const text = TEXT[mode];
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(text.endpoint, { json: mode === "signup" ? { name, email, password } : { email, password } });
      const next = new URLSearchParams(window.location.search).get("next");
      // A full load, so every part of the page sees the new session.
      window.location.href = mode === "admin" ? "/admin" : next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="auth-card card">
      <div className="auth-brand">
        <img src="/fynktech-logo.png" alt="" className="brand-logo" />
        <span>FynkTech</span>
      </div>
      <header className="stack-tight">
        <h1>{text.title}</h1>
        <p className="muted">{text.lead}</p>
      </header>
      <form className="form" onSubmit={submit}>
        {mode === "signup" && (
          <label className="field">
            <span>Name</span>
            <input type="text" name="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
          </label>
        )}
        <label className="field">
          <span>Email</span>
          <input type="email" name="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            name="password"
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={mode === "signup" ? 8 : undefined}
          />
          {mode === "signup" && <small className="muted">At least 8 characters.</small>}
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? text.busy : text.button}
        </button>
      </form>
      {mode === "login" && (
        <p className="muted small">
          New here? <Link href="/signup">Create an account</Link>
        </p>
      )}
      {mode === "signup" && (
        <p className="muted small">
          Already have an account? <Link href="/login">Log in</Link>
        </p>
      )}
    </div>
  );
}

"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "./api";

type Mode = "login" | "signup" | "admin";

interface Copy {
  title: string;
  lead: string;
  button: string;
  busy: string;
  endpoint: string;
  headline: string;
  intro: string;
}

const TEXT: Record<Mode, Copy> = {
  login: {
    title: "Welcome back",
    lead: "Sign in to your account to continue.",
    button: "Sign in",
    busy: "Signing in...",
    endpoint: "/api/auth/login",
    headline: "From a product link to a Shopify draft.",
    intro: "Research a product, review what the AI wrote, and send it to your store as a draft. You stay in control.",
  },
  signup: {
    title: "Create your account",
    lead: "Sign up free. You get 2 free searches to try the app.",
    button: "Sign up",
    busy: "Creating your account...",
    endpoint: "/api/auth/signup",
    headline: "Start listing products in minutes.",
    intro: "Your free account includes 2 searches. No card needed to try it.",
  },
  admin: {
    title: "Admin login",
    lead: "Only the admin can log in here.",
    button: "Log in as admin",
    busy: "Logging in...",
    endpoint: "/api/admin/login",
    headline: "Run the whole workspace from one place.",
    intro: "Users, plans, billing requests and search keys, all in the admin portal.",
  },
};

const FEATURES = [
  { title: "Research that does the reading", body: "Finds the product on the web and collects photos, details and prices for you." },
  { title: "AI-written listings", body: "Titles, descriptions and the Bundle product page text, ready to review and edit." },
  { title: "Drafts only, never live by surprise", body: "Everything reaches Shopify as a DRAFT until you publish it yourself." },
];

function Check() {
  return (
    <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.5 10.5l3.5 3.5 7.5-8" />
    </svg>
  );
}

function Lock() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="10.5" width="14" height="9.5" rx="2.4" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
    </svg>
  );
}

function Eye({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
      {off && <path d="M4 4l16 16" />}
    </svg>
  );
}

export function AuthForm({ mode }: { mode: Mode }) {
  const text = TEXT[mode];
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
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
    <div className="auth-page">
      <aside className="auth-aside">
        <div className="auth-aside-brand">
          <span className="auth-logo">
            <img src="/fynktech-logo.png" alt="" />
          </span>
          <span className="auth-aside-name">
            FynkTech
            <small>Product listing</small>
          </span>
        </div>

        <div className="auth-aside-body">
          <h2 className="auth-headline">{text.headline}</h2>
          <p className="auth-intro">{text.intro}</p>
          <ul className="auth-features">
            {FEATURES.map((feature) => (
              <li key={feature.title}>
                <span className="auth-check">
                  <Check />
                </span>
                <span>
                  <strong>{feature.title}</strong>
                  <small>{feature.body}</small>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <p className="auth-copy">&copy; 2026 FynkTech. All rights reserved.</p>
      </aside>

      <section className="auth-panel">
        <div className="auth-card">
          <span className="auth-badge">
            <Lock />
          </span>
          <header className="auth-head">
            <h1>{text.title}</h1>
            <p>{text.lead}</p>
          </header>
          <form className="auth-form" onSubmit={submit}>
            {mode === "signup" && (
              <label className="auth-field">
                <span>Name</span>
                <input type="text" name="name" autoComplete="name" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
              </label>
            )}
            <label className="auth-field">
              <span>Email</span>
              <input type="email" name="email" autoComplete="email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            <label className="auth-field">
              <span>Password</span>
              <span className="auth-password">
                <input
                  type={showPassword ? "text" : "password"}
                  name="password"
                  autoComplete={mode === "signup" ? "new-password" : "current-password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={mode === "signup" ? 8 : undefined}
                />
                <button type="button" className="auth-eye" onClick={() => setShowPassword((on) => !on)} aria-label={showPassword ? "Hide" : "Show"} aria-pressed={showPassword}>
                  <Eye off={showPassword} />
                </button>
              </span>
              {mode === "signup" && <small className="auth-hint">At least 8 characters.</small>}
            </label>
            {error && (
              <p className="auth-error" role="alert">
                {error}
              </p>
            )}
            <button className="auth-submit" type="submit" disabled={busy}>
              {busy ? text.busy : text.button}
            </button>
          </form>

          {mode !== "admin" && (
          <div className="auth-foot">
            {mode === "login" && (
              <p>
                New here? <Link href="/signup">Create an account</Link>
              </p>
            )}
            {mode === "signup" && (
              <p>
                Already have an account? <Link href="/login">Log in</Link>
              </p>
            )}
          </div>
          )}
        </div>
        <p className="auth-note">Protected by secure account access.</p>
      </section>
    </div>
  );
}

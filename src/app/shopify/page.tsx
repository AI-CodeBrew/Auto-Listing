"use client";

import { useEffect, useState } from "react";
import { api, usePolling } from "@/components/api";
import { SerpKeys } from "@/components/SerpKeys";

interface Summary {
  domain: string;
  clientId: string;
  hasSecret: boolean;
  source: "page" | "env" | "none";
}

interface TestResult {
  shopName: string;
  domain: string;
  missingScopes: string[];
}

export default function ShopifyPage() {
  const summary = usePolling<Summary>("/api/settings/shopify", 60_000);
  const [domain, setDomain] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<"save" | "test" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);

  // Fills the form once from what is saved. Later refreshes must not overwrite typing.
  useEffect(() => {
    if (summary.data && !loaded) {
      setDomain(summary.data.domain);
      setClientId(summary.data.clientId);
      setLoaded(true);
    }
  }, [summary.data, loaded]);

  const saved = summary.data;
  const connected = Boolean(saved && saved.domain && saved.clientId && saved.hasSecret);
  const [open, setOpen] = useState<null | "shopify" | "serp">(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy("save");
    setError(null);
    setMessage(null);
    setTest(null);
    try {
      const body = await api<Summary>("/api/settings/shopify", { method: "PUT", json: { domain, clientId, clientSecret } });
      setDomain(body.domain);
      setClientSecret("");
      setMessage("Saved. Press Test connection to check that Shopify accepts these details.");
      await summary.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function testConnection() {
    setBusy("test");
    setError(null);
    setMessage(null);
    setTest(null);
    try {
      setTest(await api<TestResult>("/api/settings/shopify/test", { json: {} }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!window.confirm("Remove the saved Shopify details from this app?")) return;
    setBusy("remove");
    setError(null);
    setMessage(null);
    setTest(null);
    try {
      const body = await api<Summary>("/api/settings/shopify", { method: "DELETE" });
      setDomain(body.domain);
      setClientId(body.clientId);
      setClientSecret("");
      setMessage("Shopify details removed.");
      await summary.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="page stack">
      <header className="page-head">
        <h1>Integrations</h1>
        <p>Choose Shopify or SerpAPI.</p>
      </header>
      <div className="integration-grid">
        <button type="button" className={open === "shopify" ? "integration-option integration-option-on" : "integration-option"} aria-expanded={open === "shopify"} onClick={() => setOpen(open === "shopify" ? null : "shopify")}>
          <ShopifyLogo large />
          <span>Shopify</span>
        </button>
        <button type="button" className={open === "serp" ? "integration-option integration-option-on" : "integration-option"} aria-expanded={open === "serp"} onClick={() => setOpen(open === "serp" ? null : "serp")}>
          <SerpApiLogo large />
          <span>SerpAPI</span>
        </button>
      </div>
      {open === "serp" && <SerpKeys controls />}
      {open === "shopify" && <>
      <section className="card stack">
        <div className="row row-between">
          <h2 className="row">
            <ShopifyLogo />
            Shopify
          </h2>
          <span className={connected ? "pill pill-shopify-draft" : "pill pill-muted"} data-testid="shopify-connection-state">
            {connected ? "Details saved" : "Not connected"}
          </span>
        </div>
        <p className="muted">
          Connect your store so approved products can be created as <strong>drafts</strong> in Shopify. Nothing is ever published.
        </p>

        {saved?.source === "env" && (
          <div className="notice" role="status">
            These details are currently coming from the <code>.env</code> file. Saving here will use the values below instead.
          </div>
        )}

        <form onSubmit={save} className="form" data-testid="shopify-form">
          <label className="field">
            <span>Store domain</span>
            <input
              type="text"
              name="domain"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="my-store.myshopify.com"
              autoComplete="off"
              spellCheck={false}
              data-testid="shopify-domain"
            />
            <small className="muted">The address ending in .myshopify.com. You can also paste just the store name.</small>
          </label>
          <label className="field">
            <span>Client ID</span>
            <input type="text" name="clientId" value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} data-testid="shopify-client-id" />
          </label>
          <label className="field">
            <span>Client secret</span>
            <input
              type="password"
              name="clientSecret"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={saved?.hasSecret ? "Saved. Leave empty to keep it." : ""}
              autoComplete="new-password"
              data-testid="shopify-client-secret"
            />
            <small className="muted">The secret is stored only on this computer and is never shown again.</small>
          </label>

          {error && <p className="error" role="alert" data-testid="shopify-form-error">{error}</p>}
          {message && !error && <p className="muted" role="status" data-testid="shopify-form-message">{message}</p>}
          {test && (
            <div className={test.missingScopes.length ? "notice notice-warn" : "notice"} role="status" data-testid="shopify-test-result">
              <strong>Connected to {test.shopName}</strong> ({test.domain}).
              {test.missingScopes.length > 0 && (
                <> The app is missing these permissions: <code>{test.missingScopes.join(", ")}</code>. Add them to the app version in the Dev Dashboard, release it, and test again.</>
              )}
            </div>
          )}

          <div className="row">
            <button className="btn btn-primary" type="submit" disabled={busy !== null} data-testid="shopify-save">
              {busy === "save" ? "Saving..." : "Save"}
            </button>
            <button className="btn" type="button" disabled={busy !== null || !connected} onClick={testConnection} data-testid="shopify-test">
              {busy === "test" ? "Testing..." : "Test connection"}
            </button>
            {saved?.source === "page" && (
              <button className="btn" type="button" disabled={busy !== null} onClick={remove} data-testid="shopify-remove">
                Remove
              </button>
            )}
          </div>
        </form>
      </section>

      <section className="card stack-tight">
        <h2>Where do I get these?</h2>
        <ol>
          <li>Open the <a href="https://dev.shopify.com/dashboard" target="_blank" rel="noopener noreferrer">Shopify Dev Dashboard</a> and create an app.</li>
          <li>In the app version, add the scopes <code>write_products</code> and <code>write_inventory</code>, then release the version.</li>
          <li>Install the app on your store. The app and the store must be in the same organization.</li>
          <li>Open the app&apos;s <strong>Settings</strong> and copy the <strong>Client ID</strong> and <strong>Secret</strong> into the form above.</li>
        </ol>
      </section>
      </>}
    </div>
  );
}

function ShopifyLogo({ large = false }: { large?: boolean }) {
  return (
    <svg className={large ? "integration-logo" : "integration-logo-sm"} viewBox="0 0 109.5 124.5" aria-hidden="true">
      <path fill="#95BF47" d="M95.9 23.9c-.1-.6-.6-1-1.1-1-.5 0-9.3-.2-9.3-.2s-7.4-7.2-8.1-7.9c-.7-.7-2.2-.5-2.7-.3 0 0-1.4.4-3.7 1.1-.4-1.3-1-2.8-1.8-4.4-2.6-5-6.5-7.7-11.1-7.7 0 0 0 0 0 0-.3 0-.6 0-1 .1-.1-.2-.3-.3-.4-.5-2-2.2-4.6-3.2-7.7-3.1-6 .2-12 4.5-16.8 12.2-3.4 5.4-6 12.2-6.7 17.5-6.9 2.1-11.7 3.6-11.8 3.7-3.5 1.1-3.6 1.2-4 4.5C8.4 40.2-.8 110.8-.8 110.8l75.6 13.1V23.9h21.1z" />
      <path fill="#5E8E3E" d="M94.8 22.9c-.5 0-9.3-.2-9.3-.2s-7.4-7.2-8.1-7.9c-.3-.3-.6-.4-1-.5l-10.2 110.2 31.4-6.8C97.6 117.6 95.9 24.9 94.8 22.9z" />
      <path fill="#FFF" d="M57.6 39.2s-3.6-1.9-8-1.9c-6.4 0-6.7 4-6.7 5 0 5.5 14.3 7.6 14.3 20.5 0 10.1-6.4 16.6-15.1 16.6-10.4 0-15.7-6.5-15.7-6.5l2.8-9.2s5.5 4.7 10.1 4.7c3 0 4.3-2.4 4.3-4.1 0-7.2-11.8-7.5-11.8-19.3 0-9.9 7.1-19.5 21.5-19.5 5.5 0 8.3 1.6 8.3 1.6l-4 12.1z" />
    </svg>
  );
}

function SerpApiLogo({ large = false }: { large?: boolean }) {
  return (
    <svg className={large ? "integration-logo" : "integration-logo-sm"} viewBox="0 0 48 48" aria-hidden="true">
      <rect width="48" height="48" rx="12" fill="#111827" />
      <circle cx="21" cy="21" r="8" fill="none" stroke="#4ade80" strokeWidth="3" />
      <path d="M27 27 L36 36" stroke="#4ade80" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

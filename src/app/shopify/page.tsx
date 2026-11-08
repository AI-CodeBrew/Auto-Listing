"use client";

import { useEffect, useState } from "react";
import { api, usePolling } from "@/components/api";

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
    <div className="stack">
      <section className="card stack">
        <div className="row row-between">
          <h1>Shopify</h1>
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
    </div>
  );
}

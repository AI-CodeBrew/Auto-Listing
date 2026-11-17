"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { formatBytes, usePolling } from "@/components/api";
import { HoverScrollImage } from "@/components/HoverScrollImage";
import { PushLinks, RenderedPreview, pushTemplate, type Push, type PushResult } from "@/components/TemplateParts";

interface StoreTemplate {
  id: string;
  name: string;
  tagline: string;
  preview: string;
  previewPage: string;
  afterPush: string;
  files: number;
  bytes: number;
  lastPush: Push | null;
}

interface Data {
  store: { domain: string; missing: string[] };
  running: boolean;
  templates: StoreTemplate[];
}

/** A link followed inside the sample store: the preview shows the page that matches it. */
function samplePage(base: string, href: string): string | null {
  if (href === "/") return base;
  if (/^\/collections(\/[^/]+)?$/.test(href)) return base.replace(".html", "-collection.html");
  if (/^\/products\/[^/]+$/.test(href)) return base.replace(".html", "-product.html");
  return null;
}

export default function StoreTemplatePage() {
  const { data, error, refresh } = usePolling<Data>("/api/store-templates", 60_000);
  const connected = Boolean(data && data.store.missing.length === 0);
  return (
    <div className="page stack">
      <header className="page-head">
        <h1>Entire store template</h1>
        <p>A whole store design. A push gives your live theme the home page, collection pages, header and footer. The product page you already have stays as it is.</p>
      </header>

      {error && <p className="error" role="alert">{error}</p>}
      {data && !connected && (
        <div className="notice notice-warn" role="status" data-testid="template-not-connected">
          <span>
            Connect your Shopify store first on the <Link href="/shopify">Integrations</Link> page. Missing: {data.store.missing.join(", ")}.
          </span>
        </div>
      )}

      <div className="tpl-grid">
        {data?.templates.map((template) => (
          <StoreCard key={template.id} template={template} domain={data.store.domain} connected={connected} busyElsewhere={data.running} onPushed={refresh} />
        ))}
      </div>
    </div>
  );
}

function StoreCard({
  template,
  domain,
  connected,
  busyElsewhere,
  onPushed,
}: {
  template: StoreTemplate;
  domain: string;
  connected: boolean;
  busyElsewhere: boolean;
  onPushed: () => Promise<void>;
}) {
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [steps, setSteps] = useState<string[]>([]);
  const [result, setResult] = useState<PushResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const running = status === "running";
  const resolvePage = useCallback((href: string) => samplePage(template.previewPage, href), [template.previewPage]);

  async function push() {
    const question = `This gives the live theme of ${domain} the ${template.name} design. Your home page, collection pages, collection list, header and footer are replaced. Your product page and your products do not change. Continue?`;
    if (!window.confirm(question)) return;
    setStatus("running");
    setSteps([]);
    setResult(null);
    setMessage(null);
    try {
      const pushed = await pushTemplate(template.id, (step) => setSteps((list) => [...list, step]));
      setResult(pushed);
      setStatus("done");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
      setStatus("error");
    } finally {
      void onPushed();
    }
  }

  const shown = result ?? template.lastPush;

  return (
    <section className="tpl-card" data-testid={`store-template-${template.id}`}>
      <div className="tpl-thumb">
        <HoverScrollImage src={template.preview} alt={`${template.name} preview`} />
        {shown && (
          <div className="tpl-strip" data-testid={result ? "template-push-result" : "template-last-push"}>
            <span className="tpl-ok">
              <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4.5 10.5l3.5 3.5 7.5-8" />
              </svg>
              Set up in your store
            </span>
            <span className="tpl-date" title={shown.themeName}>
              {new Date(shown.at).toLocaleDateString()}
            </span>
            <PushLinks links={[{ label: "View store", href: shown.previewUrl }, { label: "Theme editor", href: shown.editorUrl }]} />
          </div>
        )}
      </div>

      <div className="tpl-body">
        <div className="tpl-head">
          <div className="tpl-titlebar">
            <h2>{template.name}</h2>
            <span className="tpl-meta">
              {template.files} files · {formatBytes(template.bytes)}
            </span>
          </div>
          <p className="tpl-tagline">{template.tagline}</p>
        </div>

        <div className="tpl-actions">
          <button className="btn tpl-btn" type="button" onClick={() => setPreviewing(true)} data-testid="template-preview">
            Preview
          </button>
          <button className="btn btn-primary tpl-btn" type="button" disabled={!connected || running || busyElsewhere} onClick={push} data-testid="template-push">
            {running ? "Adding..." : shown ? "Update in my store" : "Use this store design"}
          </button>
        </div>

        {running && (
          <div className="activity" role="status" data-testid="template-push-progress">
            <div className="activity-live">
              <span className="activity-pulse" aria-hidden="true" />
              <p className="activity-now">{steps.at(-1) ?? "Starting..."}</p>
            </div>
            {steps.length > 1 && (
              <ol className="activity-log">
                {steps.slice(0, -1).map((step, index) => (
                  <li key={index}>{step}</li>
                ))}
              </ol>
            )}
          </div>
        )}

        {status === "error" && message && (
          <div className="notice notice-error" role="alert" data-testid="template-push-error">
            {message}
          </div>
        )}

        {result && result.warnings.length > 0 && (
          <div className="notice notice-warn" role="status">
            <ul className="small">
              {result.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        )}

        {result && <p className="tpl-note">{template.afterPush}</p>}
      </div>

      {previewing && (
        <RenderedPreview
          name={template.name}
          src={template.previewPage}
          note="A sample store, so you can see the design before you push. Your store shows its own products, menus and photos."
          resolvePage={resolvePage}
          onClose={() => setPreviewing(false)}
        />
      )}
    </section>
  );
}

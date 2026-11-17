"use client";

import Link from "next/link";
import { useState } from "react";
import { api, formatBytes, usePolling } from "@/components/api";
import { HoverScrollImage } from "@/components/HoverScrollImage";
import { SaamanoPreview } from "@/components/SaamanoPreview";
import { SAMPLE_PRODUCT, SAMPLE_RELATED, SAMPLE_STORY } from "@/components/sample-product";
import { PushLinks, RenderedPreview, pushTemplate, type Push, type PushResult } from "@/components/TemplateParts";

interface Template {
  id: string;
  name: string;
  templateSuffix: string;
  tagline: string;
  useForNew: boolean;
  preview: string;
  afterPush: string;
  files: number;
  bytes: number;
  lastPush: Push | null;
}

interface Data {
  store: { domain: string; missing: string[] };
  running: boolean;
  templates: Template[];
}

export default function TemplatePage() {
  const { data, error, refresh } = usePolling<Data>("/api/templates", 60_000);
  const connected = Boolean(data && data.store.missing.length === 0);
  return (
    <div className="page stack">
      <header className="page-head">
        <h1>Product page template</h1>
        <p>Product page designs. A push adds the page to your store&apos;s theme. Nothing else changes.</p>
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
          <TemplateCard key={template.id} template={template} domain={data.store.domain} connected={connected} busyElsewhere={data.running} onPushed={refresh} />
        ))}
      </div>
    </div>
  );
}

function TemplateCard({
  template,
  domain,
  connected,
  busyElsewhere,
  onPushed,
}: {
  template: Template;
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

  async function push() {
    const question = `This adds the ${template.name} to the live theme of ${domain}${template.useForNew ? "" : " and uses it for the products you push from now on"}. It only adds new files: your home page, header, footer, contact page and other products do not change. Continue?`;
    if (!window.confirm(question)) return;
    setStatus("running");
    setSteps([]);
    setResult(null);
    setMessage(null);
    try {
      const pushed = await pushTemplate(template.id, (step) => setSteps((list) => [...list, step]));
      setResult(pushed);
      setStatus("done");
      // Only one page is set at a time: the one just added is now the page new products get.
      if (!template.useForNew) await api(`/api/templates/${template.id}/use`, { json: {} });
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
      setStatus("error");
    } finally {
      void onPushed();
    }
  }

  const last = template.lastPush;
  // Only the page that is set shows its status. The other pages show a button to use them instead.
  const shown = template.useForNew ? (result ?? last) : null;

  return (
    <section className="tpl-card" data-testid={`template-${template.id}`}>
      <div className="tpl-thumb">
        <HoverScrollImage src={template.preview} alt={`${template.name} preview`} />
        {template.useForNew && (
          <span className="tpl-badge" data-testid="template-in-use">
            Used for new products
          </span>
        )}

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
          <PushLinks links={[{ label: "Preview page", href: shown.productPreviewUrl }, { label: "Theme editor", href: shown.editorUrl }]} />
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
            {running ? "Adding..." : !template.useForNew ? "Use this page" : shown ? "Update in my store" : "Add to my store"}
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

      {previewing && template.id === "saamano" && <SaamanoPreview sampleStory={SAMPLE_STORY} product={SAMPLE_PRODUCT} related={SAMPLE_RELATED} onClose={() => setPreviewing(false)} />}
      {previewing && template.id !== "saamano" && <RenderedPreview name={template.name} src={`/template-preview/${template.id}.html`} note="A sample product, so you can see the design before you push. Your products show their own photos and text." onClose={() => setPreviewing(false)} />}

    </section>
  );
}

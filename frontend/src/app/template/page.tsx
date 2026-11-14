"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, formatBytes, safeHref, usePolling } from "@/components/api";
import { HoverScrollImage } from "@/components/HoverScrollImage";
import { SaamanoPreview } from "@/components/SaamanoPreview";
import { SAMPLE_PRODUCT, SAMPLE_RELATED, SAMPLE_STORY } from "@/components/sample-product";

interface Push {
  domain: string;
  themeId: string;
  themeName: string;
  previewUrl: string;
  productPreviewUrl: string | null;
  editorUrl: string;
  at: string;
}

interface PushResult extends Push {
  uploaded: number;
  unchanged: number;
  removed: number;
  warnings: string[];
}

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
        <h1>Template</h1>
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
      const response = await fetch(`/api/templates/${template.id}/push`, { method: "POST", cache: "no-store" });
      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Request failed (${response.status})`);
      }
      // One JSON object per line: progress steps, then "done" or "error".
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      let finished = false;
      let pushed = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (value) buffer += value;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const event = JSON.parse(line) as { type: string; step?: string; result?: PushResult; message?: string };
          if (event.type === "progress" && event.step) setSteps((list) => [...list, event.step!]);
          if (event.type === "done" && event.result) {
            setResult(event.result);
            setStatus("done");
            finished = true;
            pushed = true;
          }
          if (event.type === "error") {
            setMessage(event.message ?? "The push failed.");
            setStatus("error");
            finished = true;
          }
        }
        if (done) break;
      }
      if (!finished) throw new Error("The connection closed before the push finished. Check Online Store → Themes in your Shopify admin.");
      // Only one page is set at a time: the one just added is now the page new products get.
      if (pushed && !template.useForNew) await api(`/api/templates/${template.id}/use`, { json: {} });
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
          <PushLinks push={shown} />
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
      {previewing && template.id !== "saamano" && <RenderedPreview name={template.name} src={`/template-preview/${template.id}.html`} onClose={() => setPreviewing(false)} />}

    </section>
  );
}

/** The page as the store draws it: the real Liquid files, rendered once with the sample product. */
function RenderedPreview({ name, src, onClose }: { name: string; src: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    // Escape pressed inside the page: the page tells this window (see the script in the preview file).
    const onMessage = (event: MessageEvent) => {
      if (event.origin === window.location.origin && event.data === "fynk-close-preview") onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("message", onMessage);
    };
  }, [onClose]);
  return (
    <div className="sp-overlay" role="dialog" aria-modal="true" aria-label={`${name} preview`} data-testid="rendered-preview">
      <div className="sp-bar">
        <p>
          <strong>{name}</strong> · A sample product, so you can see the design before you push. Your products show their own photos and text.
        </p>
        <button className="btn" type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <iframe className="tpl-frame" src={src} title={`${name} preview`} data-testid="rendered-frame" />
    </div>
  );
}

function PushLinks({ push, before }: { push: Push; before?: React.ReactNode }) {
  const links = [
    { label: "Preview page", href: push.productPreviewUrl },
    { label: "Theme editor", href: push.editorUrl },
  ];
  return (
    <span className="tpl-links">
      {before}
      {links.map((link) => {
        const href = safeHref(link.href);
        return href ? (
          <a key={link.label} className="tpl-link" href={href} target="_blank" rel="noopener noreferrer">
            {link.label}
          </a>
        ) : null;
      })}
    </span>
  );
}

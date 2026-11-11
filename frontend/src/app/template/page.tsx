"use client";

import Link from "next/link";
import { useState } from "react";
import { formatBytes, safeHref, usePolling } from "@/components/api";
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
  description: string;
  productPage: string[];
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
        <p>Product page designs. A push adds the page to your store&apos;s current theme. The rest of your store stays as it is.</p>
      </header>

      {error && <p className="error" role="alert">{error}</p>}
      {data && !connected && (
        <div className="notice notice-warn" role="status" data-testid="template-not-connected">
          <span>
            Connect your Shopify store first on the <Link href="/shopify">Integrations</Link> page. Missing: {data.store.missing.join(", ")}.
          </span>
        </div>
      )}

      {data?.templates.map((template) => (
        <TemplateCard key={template.id} template={template} domain={data.store.domain} connected={connected} busyElsewhere={data.running} onPushed={refresh} />
      ))}
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
  // The app can draw this design itself, so it can be seen before it is pushed.
  const canPreview = template.id === "saamano";

  async function push() {
    const question = `This adds the ${template.name} to the live theme of ${domain}. It only adds new files: your home page, header, footer, contact page and other products do not change. Only products you push from this app will use it. Push now?`;
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
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
      setStatus("error");
    } finally {
      void onPushed();
    }
  }

  const last = template.lastPush;

  return (
    <section className="card stack" data-testid={`template-${template.id}`}>
      <div className="row row-between">
        <div className="stack-tight">
          <h2>{template.name}</h2>
          <p className="muted small">
            Adds {template.files} files to your theme · {formatBytes(template.bytes)}
          </p>
        </div>
        <div className="row">
          {canPreview && (
            <button className="btn" type="button" onClick={() => setPreviewing(true)} data-testid="template-preview">
              Preview
            </button>
          )}
          <button className="btn btn-primary" type="button" disabled={!connected || running || busyElsewhere} onClick={push} data-testid="template-push">
            {running ? "Pushing..." : "Push to Shopify"}
          </button>
        </div>
      </div>
      {previewing && <SaamanoPreview sampleStory={SAMPLE_STORY} product={SAMPLE_PRODUCT} related={SAMPLE_RELATED} onClose={() => setPreviewing(false)} />}

      <p>{template.description}</p>
      <div className="stack-tight">
        <h3>The product page</h3>
        <ol>
          {template.productPage.map((part) => (
            <li key={part}>{part}</li>
          ))}
        </ol>
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

      {result && (
        <div className={result.warnings.length ? "notice notice-warn" : "notice"} role="status" data-testid="template-push-result">
          <span>
            <strong>The product page is in your live theme &quot;{result.themeName}&quot; on {result.domain}.</strong>
          </span>
          <PushLinks push={result} />
          <span className="small">
            {result.uploaded} files added. Nothing else in your store changed.
          </span>
          {result.warnings.length > 0 && (
            <ul className="small">
              {result.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
          <span className="small">
            Products you push from <strong>Approved listings</strong> now use this page. Your other products keep their usual page.
          </span>
        </div>
      )}

      {!result && last && (
        <div className="stack-tight small" data-testid="template-last-push">
          <span className="muted">
            Added to your theme &quot;{last.themeName}&quot; on {new Date(last.at).toLocaleString()}.
          </span>
          <PushLinks push={last} />
        </div>
      )}
    </section>
  );
}

function PushLinks({ push }: { push: Push }) {
  const links = [
    { label: "Preview the product page", href: push.productPreviewUrl },
    { label: "Open in theme editor", href: push.editorUrl },
  ];
  return (
    <div className="row row-wrap">
      {links.map((link) => {
        const href = safeHref(link.href);
        return href ? (
          <a key={link.label} className="btn" href={href} target="_blank" rel="noopener noreferrer">
            {link.label}
          </a>
        ) : null;
      })}
    </div>
  );
}

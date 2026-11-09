"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, usePolling } from "@/components/api";
import { ResearchActivity } from "@/components/ResearchActivity";
import type { Job } from "@/lib/types";
interface Status {
  ai: { ok: boolean; message: string | null };
}

interface LocalFile {
  id: string;
  file: File;
  preview: string | null;
  kind: "image" | "video";
}

const MAX_IMAGES = 20;
const IMAGE_MAX = 20 * 1024 * 1024;
const VIDEO_MAX = 1024 * 1024 * 1024;
const VIDEO_EXT = /\.(mp4|mov|webm)$/i;

export default function NewProductPage() {
  const [name, setName] = useState("");
  const [details, setDetails] = useState("");
  const [urls, setUrls] = useState("");
  const [files, setFiles] = useState<LocalFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [searchPhotos, setSearchPhotos] = useState(true);
  const [searchVideos, setSearchVideos] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [active, setActive] = useState<{ id: string; name: string; job: Job | null } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef(files);
  const dragDepth = useRef(0);
  filesRef.current = files;
  const status = usePolling<Status>("/api/status", 10000);
  const images = files.filter((item) => item.kind === "image");
  const hasPhoto = images.length > 0;

  useEffect(() => {
    return () => {
      for (const item of filesRef.current) if (item.preview) URL.revokeObjectURL(item.preview);
    };
  }, []);

  function addFiles(list: FileList | File[]) {
    const incoming = Array.from(list);
    if (!incoming.length) return;
    const next = [...filesRef.current];
    let message: string | null = null;
    for (const file of incoming) {
      const video = file.type.startsWith("video/") || VIDEO_EXT.test(file.name);
      const image = file.type.startsWith("image/");
      if (!video && !image) {
        message = "Add an image, or an MP4, MOV or WEBM video.";
        continue;
      }
      if (video) {
        if (file.size > VIDEO_MAX) {
          message = "Videos can be at most 1 GB.";
          continue;
        }
        const kept = next.filter((item) => item.kind !== "video");
        next.length = 0;
        next.push(...kept, { id: crypto.randomUUID(), file, preview: null, kind: "video" });
        continue;
      }
      if (file.size > IMAGE_MAX) {
        message = "Images can be at most 20 MB.";
        continue;
      }
      if (next.filter((item) => item.kind === "image").length >= MAX_IMAGES) {
        message = `You can add up to ${MAX_IMAGES} images.`;
        continue;
      }
      next.push({ id: crypto.randomUUID(), file, preview: URL.createObjectURL(file), kind: "image" });
    }
    setError(message);
    setFiles(next);
  }

  function removeFile(id: string) {
    setFiles((current) => {
      const item = current.find((entry) => entry.id === id);
      if (item?.preview) URL.revokeObjectURL(item.preview);
      return current.filter((entry) => entry.id !== id);
    });
  }

  function clearFiles() {
    for (const item of files) if (item.preview) URL.revokeObjectURL(item.preview);
    setFiles([]);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!files.length && !name.trim()) {
      setError("Enter a product name, or add an image or video.");
      return;
    }
    const form = new FormData();
    form.append("name", name);
    form.append("details", details);
    form.append("urls", urls);
    form.append("search_photos", searchPhotos ? "1" : "0");
    form.append("search_videos", searchVideos ? "1" : "0");
    for (const item of files) form.append("file", item.file);
    setSubmitting(true);
    try {
      const created = await api<{ product: { id: string }; job: Job | null }>("/api/products", { form });
      setActive({ id: created.product.id, name: name.trim() || "Your product", job: created.job });
      setName("");
      setDetails("");
      setUrls("");
      clearFiles();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page stack">
      <header className="page-head">
        <h1>Add new listing</h1>
        <p>Add your photos. The title, description, and matching pictures show up in Review listings.</p>
      </header>
      {status.data && !status.data.ai.ok && (
        <div className="notice notice-warn" role="status" data-testid="ai-warning">
          <strong>Research cannot run yet.</strong> {status.data.ai.message}
        </div>
      )}
      {active && (
        <section className="card stack">
          <h2>{active.name}</h2>
          <ResearchActivity productId={active.id} initialJob={active.job} />
        </section>
      )}
      <section className="card form-card">
        <form onSubmit={submit} className="form">
          <div className="field">
            <span>Photos</span>
            <div
              className={dragging ? "dropzone dropzone-on" : "dropzone"}
              onDragEnter={(event) => {
                event.preventDefault();
                dragDepth.current += 1;
                setDragging(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => {
                event.preventDefault();
                dragDepth.current -= 1;
                if (dragDepth.current <= 0) {
                  dragDepth.current = 0;
                  setDragging(false);
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                dragDepth.current = 0;
                setDragging(false);
                addFiles(event.dataTransfer.files);
              }}
            >
              <input
                ref={fileRef}
                className="drop-input"
                type="file"
                name="file"
                multiple
                accept="image/*,video/mp4,video/quicktime,video/webm,.mov"
                onChange={(event) => {
                  if (event.target.files) addFiles(event.target.files);
                  event.target.value = "";
                }}
              />
              {files.length === 0 ? (
                <button type="button" className="drop-empty" onClick={() => fileRef.current?.click()}>
                  <DropIcon />
                  <strong>Drop images here</strong>
                  <span className="muted">or click to browse. You can add several at once.</span>
                </button>
              ) : (
                <div className="drop-filled">
                  <div className="drop-grid">
                    {files.map((item, index) => (
                      <figure key={item.id} className="drop-thumb">
                        {item.preview ? <img src={item.preview} alt="" /> : <span className="drop-video">{item.file.name}</span>}
                        {item.kind === "image" && images[0]?.id === item.id && <span className="drop-badge">Main</span>}
                        <button type="button" className="drop-remove" aria-label={`Remove ${item.file.name || `image ${index + 1}`}`} onClick={() => removeFile(item.id)}>
                          ×
                        </button>
                      </figure>
                    ))}
                  </div>
                  <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
                    Add more
                  </button>
                </div>
              )}
            </div>
            <small className="muted">Up to {MAX_IMAGES} images, 20 MB each. One video up to 1 GB. The first photo is used to find matches.</small>
          </div>
          <label className="field">
            <span>Product name</span>
            <input type="text" name="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Stainless steel water bottle 750 ml" />
          </label>
          <label className="field">
            <span>Product details</span>
            <textarea
              name="details"
              rows={4}
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              placeholder="Brand, material, size, colors, and how it is used."
              data-testid="product-details"
            />
          </label>
          <div className="field">
            <span>Search</span>
            <div className="toggles" role="group" aria-label="What to search">
              <button type="button" className={searchPhotos ? "toggle toggle-on" : "toggle"} aria-pressed={searchPhotos} onClick={() => setSearchPhotos((on) => !on)}>
                <span className="toggle-knob" aria-hidden="true" />
                <span className="toggle-copy">
                  <strong>Photos</strong>
                  <span className="muted small">{hasPhoto ? "Matches from your photo" : "Google Images"}</span>
                </span>
              </button>
              <button type="button" className={searchVideos ? "toggle toggle-on" : "toggle"} aria-pressed={searchVideos} onClick={() => setSearchVideos((on) => !on)}>
                <span className="toggle-knob" aria-hidden="true" />
                <span className="toggle-copy">
                  <strong>Videos</strong>
                  <span className="muted small">TikTok</span>
                </span>
              </button>
            </div>
          </div>
          <label className="field">
            <span>Product page URLs</span>
            <textarea name="urls" rows={3} value={urls} onChange={(e) => setUrls(e.target.value)} placeholder={"Optional, one per line\nhttps://example-store.com/products/water-bottle"} />
          </label>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="row">
            <button className="btn btn-primary" type="submit" disabled={submitting || (files.length === 0 && !name.trim())}>
              {submitting ? "Starting the search..." : "Start research"}
            </button>
            <Link href="/review">Open results</Link>
          </div>
        </form>
      </section>
    </div>
  );
}

function DropIcon() {
  return (
    <svg className="drop-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 16l5-5 4 4 3-3 6 6" />
      <circle cx="9" cy="9" r="1.2" />
    </svg>
  );
}

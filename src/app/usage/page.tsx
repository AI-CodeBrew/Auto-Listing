"use client";

import { SerpKeys } from "@/components/SerpKeys";

export default function UsagePage() {
  return (
    <div className="page">
      <header className="page-head">
        <h1>Usage</h1>
        <p>SerpAPI searches used and still left on each free key.</p>
      </header>
      <SerpKeys />
    </div>
  );
}

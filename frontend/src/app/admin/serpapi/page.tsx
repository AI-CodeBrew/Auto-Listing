"use client";

import { SerpKeys } from "@/components/SerpKeys";

export default function AdminSerpPage() {
  return (
    <div className="page stack">
      <header className="page-head">
        <h1>SerpAPI</h1>
        <p>Searches used and left on each key. Only you can see this. Users only see their own searches.</p>
      </header>
      <SerpKeys controls />
    </div>
  );
}

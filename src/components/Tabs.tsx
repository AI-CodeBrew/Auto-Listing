"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePolling } from "./api";

interface Status {
  counts: Record<string, number>;
}

export function Tabs() {
  const pathname = usePathname();
  const { data } = usePolling<Status>("/api/status", 2000);
  const counts = data?.counts ?? {};
  const running = (counts.researching ?? 0) + (counts.blocked ?? 0);
  const tabs = [
    { href: "/new", label: "1. New Product", count: running },
    { href: "/review", label: "2. Review", count: counts.review ?? 0 },
    { href: "/listing", label: "3. Listing", count: counts.listing ?? 0 },
    { href: "/shopify", label: "Shopify", count: 0 },
  ];
  return (
    <nav className="tabs" aria-label="Main">
      {tabs.map((tab) => (
        <Link key={tab.href} href={tab.href} className={pathname.startsWith(tab.href) ? "tab tab-active" : "tab"} aria-current={pathname.startsWith(tab.href) ? "page" : undefined}>
          {tab.label}
          {tab.count > 0 && <span className="tab-count">{tab.count}</span>}
        </Link>
      ))}
    </nav>
  );
}

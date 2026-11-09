"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { usePolling } from "./api";

interface Status {
  counts: Record<string, number>;
  listing?: { approved: number; pushed: number };
}

const LISTING_TABS = [
  { href: "/new", label: "Add new listing" },
  { href: "/review", label: "Review listings" },
  { href: "/listing", label: "Approved listings" },
  { href: "/pushed", label: "Pushed to Shopify" },
];

const GROUPS = [
  {
    label: "Workspace",
    items: [
      { href: "/", label: "Dashboard" },
      { href: "/new", label: "Listings", children: LISTING_TABS },
      { href: "/creatives", label: "Find Creatives" },
      { href: "/usage", label: "Usage" },
    ],
  },
  {
    label: "Settings",
    items: [{ href: "/shopify", label: "Integrations" }],
  },
];

export function Tabs() {
  const pathname = usePathname();
  const inListings = LISTING_TABS.some((tab) => pathname === tab.href);
  const [listingsOpen, setListingsOpen] = useState(inListings);
  useEffect(() => {
    if (inListings) setListingsOpen(true);
  }, [inListings]);
  const { data } = usePolling<Status>("/api/status", 2000);
  const counts = data?.counts ?? {};
  const countFor = (href: string) => {
    if (href === "/review") return counts.review ?? 0;
    if (href === "/listing") return data?.listing?.approved ?? 0;
    if (href === "/pushed") return data?.listing?.pushed ?? 0;
    return 0;
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <img src="/fynktech-logo.png" alt="" className="brand-logo" />
        FynkTech
      </div>
      <nav className="sidebar-nav" aria-label="Main">
        {GROUPS.map((group) => (
          <div key={group.label} className="nav-group">
            <div className="nav-label">{group.label}</div>
            {group.items.map((item) => {
              const children = "children" in item ? item.children : undefined;
              const active = item.href === "/" ? pathname === "/" : children ? children.some((child) => pathname === child.href) : pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <div key={item.href}>
                  {children ? (
                    <button
                      type="button"
                      className={active ? "nav-link nav-toggle nav-link-open" : "nav-link nav-toggle"}
                      aria-expanded={listingsOpen}
                      onClick={() => setListingsOpen((open) => !open)}
                    >
                      <span className="nav-link-label">
                        <NavIcon href={item.href} />
                        {item.label}
                      </span>
                      <span className="nav-chevron" aria-hidden="true">{listingsOpen ? "▾" : "▸"}</span>
                    </button>
                  ) : (
                    <Link href={item.href} className={active ? "nav-link nav-link-active" : "nav-link"} aria-current={active ? "page" : undefined}>
                      <span className="nav-link-label">
                        <NavIcon href={item.href} />
                        {item.label}
                      </span>
                    </Link>
                  )}
                  {children && listingsOpen && (
                    <div className="nav-sub">
                      {children.map((child) => {
                        const current = pathname === child.href;
                        const count = countFor(child.href);
                        return (
                          <Link key={child.href} href={child.href} className={current ? "nav-sublink nav-sublink-active" : "nav-sublink"} aria-current={current ? "page" : undefined}>
                            <span>{child.label}</span>
                            {count > 0 && <span className="tab-count">{count}</span>}
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}

function NavIcon({ href }: { href: string }) {
  const props = {
    className: "nav-icon",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
  };
  if (href === "/") {
    return (
      <svg {...props}>
        <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
        <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
        <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
        <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
      </svg>
    );
  }
  if (href === "/new") {
    return (
      <svg {...props}>
        <path d="M8 7h12M8 12h12M8 17h12" />
        <circle cx="4.5" cy="7" r="1" fill="currentColor" stroke="none" />
        <circle cx="4.5" cy="12" r="1" fill="currentColor" stroke="none" />
        <circle cx="4.5" cy="17" r="1" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  if (href === "/review") {
    return (
      <svg {...props}>
        <rect x="5" y="3.5" width="14" height="17" rx="2" />
        <path d="M9 3.5h6v2.5H9zM8.5 11h7M8.5 15h5" />
      </svg>
    );
  }
  if (href === "/creatives") {
    return (
      <svg {...props}>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M10 8.5v7l6-3.5z" />
      </svg>
    );
  }
  if (href === "/usage") {
    return (
      <svg {...props}>
        <path d="M4 19V10M10 19V5M16 19v-7M21 19H3" />
      </svg>
    );
  }
  return (
    <svg {...props}>
      <rect x="3" y="8" width="6.5" height="8" rx="1.5" />
      <rect x="14.5" y="8" width="6.5" height="8" rx="1.5" />
      <path d="M9.5 12h5" />
    </svg>
  );
}

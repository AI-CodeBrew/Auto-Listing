"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePolling } from "./api";
import { logOut } from "./session";

const ITEMS = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/billing", label: "Billing requests" },
  { href: "/admin/plans", label: "Plans" },
  { href: "/admin/serpapi", label: "SerpAPI" },
];

export function AdminTabs() {
  const pathname = usePathname();
  const { data } = usePolling<{ requests: { status: string }[] }>("/api/admin/billing?status=pending", 10000);
  const pending = data?.requests.length ?? 0;

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <img src="/fynktech-logo.png" alt="" className="brand-logo" />
        FynkTech
        <span className="pill pill-running">Admin</span>
      </div>
      <nav className="sidebar-nav" aria-label="Admin">
        <div className="nav-group">
          <div className="nav-label">Admin portal</div>
          {ITEMS.map((item) => {
            const active = item.href === "/admin" ? pathname === "/admin" : pathname.startsWith(item.href);
            return (
              <Link key={item.href} href={item.href} className={active ? "nav-link nav-link-active" : "nav-link"} aria-current={active ? "page" : undefined}>
                <span className="nav-link-label">{item.label}</span>
                {item.href === "/admin/billing" && pending > 0 && <span className="tab-count">{pending}</span>}
              </Link>
            );
          })}
        </div>
      </nav>
      <div className="sidebar-account">
        <button type="button" className="btn" onClick={() => void logOut("/admin/login")}>
          Log out
        </button>
      </div>
    </aside>
  );
}

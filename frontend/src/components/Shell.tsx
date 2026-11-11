"use client";

import { usePathname } from "next/navigation";
import { AccountBar } from "./AccountBar";
import { AdminTabs } from "./AdminTabs";
import { usePolling } from "./api";
import { Tabs, type Status } from "./Tabs";

const BARE_PAGES = new Set(["/login", "/signup", "/admin/login"]);

/** The login pages have no sidebar. The admin portal has its own. */
export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (BARE_PAGES.has(pathname)) return <main className="auth-main">{children}</main>;
  const admin = pathname === "/admin" || pathname.startsWith("/admin/");
  if (admin) {
    return (
      <div className="app-shell">
        <AdminTabs />
        <main className="app-main">{children}</main>
      </div>
    );
  }
  return <WorkspaceShell>{children}</WorkspaceShell>;
}

/** The sidebar on the left and the account bar in the top-right corner share one status request. */
function WorkspaceShell({ children }: { children: React.ReactNode }) {
  const { data } = usePolling<Status>("/api/status", 2000);
  return (
    <div className="app-shell">
      <Tabs status={data} />
      <div className="app-column">
        <AccountBar account={data?.account} />
        <main className="app-main">{children}</main>
      </div>
    </div>
  );
}

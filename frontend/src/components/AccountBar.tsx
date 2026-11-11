"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { logOut, useSession } from "./session";
import type { Status } from "./Tabs";

/** Up to two letters from the name ("Saamno" → "S", "Ali Hassan" → "AH"), or the email's first letter. */
function initials(name: string, email: string): string {
  const letters = name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]);
  return (letters.join("") || email[0] || "?").toUpperCase();
}

/** The top bar of every workspace page: searches left and the account menu in the right corner. */
export function AccountBar({ account }: { account: Status["account"] | undefined }) {
  const { session } = useSession();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const items = () => Array.from(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const onDown = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Escape closes and returns to the button; the arrow keys move through the menu; Tab leaves it.
  const onMenuKey = (event: React.KeyboardEvent) => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      button.current?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      list[(at + step + list.length) % list.length]?.focus();
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  if (!session) return <header className="account-bar" />;
  const isAdmin = session.role === "admin";
  const left = account?.searchesLeft;

  return (
    <header className="account-bar" data-testid="account-bar">
      {!isAdmin && typeof left === "number" && (
        <Link href="/billing" className={left === 0 ? "account-searches is-empty" : "account-searches"} title="Get more searches" data-testid="searches-left">
          <svg className="account-searches__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" />
            <path d="m20 20-4.2-4.2" />
          </svg>
          <span>
            <strong>{left}</strong> {left === 1 ? "search" : "searches"} left
          </span>
        </Link>
      )}

      <div className="account-menu" ref={box} onKeyDown={open ? onMenuKey : undefined}>
        <button
          ref={button}
          type="button"
          className="account-trigger"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => setOpen((value) => !value)}
          data-testid="account-menu-button"
        >
          <span className="account-avatar" aria-hidden="true">
            {initials(session.user.name, session.user.email)}
          </span>
          <span className="account-trigger__name">{session.user.name}</span>
          <svg className="account-trigger__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>

        {open && (
          <div className="account-pop" id={menuId} role="menu" aria-label="Account" data-testid="account-menu">
            <div className="account-pop__who">
              <span className="account-avatar account-avatar--large" aria-hidden="true">
                {initials(session.user.name, session.user.email)}
              </span>
              <div className="account-pop__text">
                <strong>{session.user.name}</strong>
                <span>{session.user.email}</span>
              </div>
            </div>
            <div className="account-pop__group">
              {isAdmin ? (
                <Link href="/admin" role="menuitem" className="account-pop__item" onClick={() => setOpen(false)}>
                  Admin portal
                </Link>
              ) : (
                <Link href="/billing" role="menuitem" className="account-pop__item" onClick={() => setOpen(false)}>
                  Billing and plans
                </Link>
              )}
              <Link href="/usage" role="menuitem" className="account-pop__item" onClick={() => setOpen(false)}>
                Usage
              </Link>
            </div>
            <div className="account-pop__group">
              <button type="button" role="menuitem" className="account-pop__item account-pop__item--danger" onClick={() => void logOut(isAdmin ? "/admin/login" : "/login")}>
                Log out
              </button>
            </div>
          </div>
        )}
      </div>
    </header>
  );
}

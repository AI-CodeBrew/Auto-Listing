"use client";

import { useEffect, useState } from "react";
import { api } from "./api";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  searchesAllowed?: number;
  searchesUsed?: number;
  searchesLeft?: number;
}

export interface Session {
  role: "admin" | "user";
  user: SessionUser;
}

let cached: Promise<Session | null> | null = null;

/** Who is signed in. Read once per page load; logging in or out reloads the page. */
export function loadSession(): Promise<Session | null> {
  if (!cached) {
    cached = api<Session>("/api/auth/me").catch(() => null);
  }
  return cached;
}

export function useSession(): { session: Session | null; loading: boolean } {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    void loadSession().then((value) => {
      if (live) {
        setSession(value);
        setLoading(false);
      }
    });
    return () => {
      live = false;
    };
  }, []);
  return { session, loading };
}

export async function logOut(to = "/login"): Promise<void> {
  await api("/api/auth/logout", { method: "POST", json: {} }).catch(() => undefined);
  cached = null;
  window.location.href = to;
}

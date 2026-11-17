import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { LoginResponseSchema, MeSchema, type Me } from "@sysmon/protocol";
import { z } from "zod";
import { apiFetch, SessionExpiredError } from "../api/client";
import { useKeepAlive } from "./useKeepAlive";

export type SessionStatus = "loading" | "authed" | "anon" | "error";
export interface SessionValue {
  user: Me | null;
  status: SessionStatus;
  /** status === "error" iken: /me yanitinin neden okunamadigi (ag/sozlesme). */
  error: unknown;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  /** Oturum sunucuda bitti/iptal edildi: yerel durumu ve onbellegi temizle. */
  expire(): void;
}

const Ctx = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession, SessionProvider icinde kullanilmali");
  return v;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [user, setUser] = useState<Me | null>(null);
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let alive = true;
    apiFetch("/api/v1/me", MeSchema).then(
      (me) => { if (alive) { setUser(me); setStatus("authed"); } },
      (e) => {
        if (!alive) return;
        if (e instanceof SessionExpiredError) { setUser(null); setStatus("anon"); } else { setError(e); setStatus("error"); }
      },
    );
    return () => { alive = false; };
  }, []);

  const expire = useCallback(() => { qc.clear(); setUser(null); setStatus("anon"); }, [qc]);

  const login = useCallback(async (email: string, password: string) => {
    const r = await apiFetch("/api/v1/login", LoginResponseSchema, { method: "POST", json: { email, password } });
    setUser(r.user); setStatus("authed"); setError(null);
  }, []);

  const logout = useCallback(async () => {
    try { await apiFetch("/api/v1/logout", z.void(), { method: "POST", json: {} }); } catch { /* sunucu yaniti ne olursa olsun yerel oturum kapanir */ }
    expire();
  }, [expire]);

  // Herhangi bir sorgu 401 (oturum) alirsa oturum yerel olarak da dusurulur -> RequireAuth girise yonlendirir.
  useEffect(() => qc.getQueryCache().subscribe((ev) => {
    if (ev.type === "updated" && ev.action.type === "error" && ev.action.error instanceof SessionExpiredError) expire();
  }), [qc, expire]);

  // Mutasyonlarda da 401 oturumu dusurur (ornegin token uretirken oturum bitti).
  useEffect(() => qc.getMutationCache().subscribe((ev) => {
    if (ev.type === "updated" && ev.action.type === "error" && ev.action.error instanceof SessionExpiredError) expire();
  }), [qc, expire]);

  useKeepAlive(expire, status === "authed");

  const value = useMemo<SessionValue>(() => ({ user, status, error, login, logout, expire }), [user, status, error, login, logout, expire]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

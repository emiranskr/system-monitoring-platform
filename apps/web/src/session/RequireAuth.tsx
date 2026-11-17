import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { ErrorState } from "../components/ErrorState";
import { useSession } from "./SessionProvider";

/** Oturumsuz ise /giris?next=<yol>'a yonlendirir; oturum durumu okunamadiysa (ag/sozlesme) acik hata gosterir. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const s = useSession();
  const loc = useLocation();
  if (s.status === "loading") return <p role="status" className="p-6 text-text-secondary">Yükleniyor…</p>;
  if (s.status === "error") return <ErrorState error={s.error} onRetry={() => window.location.reload()} />;
  if (s.status === "anon") return <Navigate to={`/giris?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <>{children}</>;
}

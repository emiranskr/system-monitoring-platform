import { SignOut } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { cn } from "../lib/cn";
import { useSession } from "../session/SessionProvider";

const link = ({ isActive }: { isActive: boolean }) =>
  cn("inline-flex min-h-11 items-center rounded-md px-3 text-sm font-medium", isActive ? "bg-surface-2 text-text-primary" : "text-text-secondary hover:text-text-primary");

/** Uygulama kabugu: "icerige gec" baglantisi, ana gezinme, kullanici + cikis. Mobilde gezinme alta sarar (yatay tasma yok). */
export function AppShell({ children }: { children: ReactNode }) {
  const s = useSession();
  return (
    <div className="min-h-screen bg-surface-0 text-text-primary">
      <a href="#icerik" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-surface-2 focus:px-3 focus:py-2">İçeriğe geç</a>
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-surface-1 px-4 py-2">
        <span className="font-semibold">Sistem İzleme</span>
        <nav aria-label="Ana gezinme" className="flex flex-wrap gap-1">
          <NavLink to="/" end className={link}>Genel bakış</NavLink>
          <NavLink to="/cihazlar" className={link}>Cihazlar</NavLink>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <span className="max-w-48 truncate text-sm text-text-secondary">{s.user?.email}</span>
          <button type="button" onClick={() => void s.logout()} className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-border bg-surface-2 px-3 text-sm hover:bg-surface-0">
            <SignOut size={16} aria-hidden="true" />
            Çıkış
          </button>
        </div>
      </header>
      <main id="icerik" tabIndex={-1}>{children}</main>
    </div>
  );
}

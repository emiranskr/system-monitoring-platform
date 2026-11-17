import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { MeSchema } from "@sysmon/protocol";
import { apiFetch, SessionExpiredError } from "../api/client";
import { usePolling } from "../api/usePolling";
import { useSession } from "../session/SessionProvider";
import { applyEvent } from "./applyEvent";
import { createLiveClient, type LiveStatus } from "./liveClient";

/** "off": tarayicida EventSource yok (canli akis kullanilamaz; yoklama calismaya devam eder). */
export type LiveState = LiveStatus | "off";
const Ctx = createContext<LiveState>("off");
export const useLive = (): LiveState => useContext(Ctx);

const REOPEN_AFTER_CLOSED_MS = 5000;

/**
 * Oturumlu alan icin TEK canli akis. Olaylar sorgu onbellegine yazilir (applyEvent). Akis kopunca banner gorunur ve
 * liste/detay 15 sn yoklamayla guncel kalir (yoklama zaten HER ZAMAN calisir: cihazin sessizce cevrimdisi olmasi SSE olayi uretmez).
 * Sunucu `closed` derse /me ile oturum dogrulanir: 401 -> giris; gecerliyse (baska neden) kisa sure sonra yeniden acilir.
 */
export function LiveProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const session = useSession();
  const [state, setState] = useState<LiveState>("off");
  usePolling(); // sabit zamanlayici: SSE onbellek yazimlari yoklamayi sifirlayamaz

  useEffect(() => {
    const ES = (globalThis as { EventSource?: typeof EventSource }).EventSource;
    if (!ES) { setState("off"); return; }
    let alive = true;
    let reopen: ReturnType<typeof setTimeout> | null = null;
    const client = createLiveClient({
      url: "/api/v1/stream",
      EventSourceImpl: ES,
      onEvent: (p) => applyEvent(qc, p),
      onStatus: (s) => {
        setState(s);
        if (s !== "closed") return;
        apiFetch("/api/v1/me", MeSchema).then(
          () => { if (alive) reopen = setTimeout(() => { client.stop(); client.start(); }, REOPEN_AFTER_CLOSED_MS); },
          (e) => { if (alive && e instanceof SessionExpiredError) session.expire(); },
        );
      },
    });
    client.start();
    return () => { alive = false; if (reopen) clearTimeout(reopen); client.stop(); };
    // session.expire kararlidir (useCallback); yalniz qc degisince yeniden kurulur
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc]);

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

/** Canli baglanti kesilince gorunen durum seridi (ekran okuyucuya `role="status"` ile bildirilir). */
export function LiveBanner() {
  const s = useLive();
  if (s !== "down") return null;
  return (
    <div role="status" className="border-b border-status-warn bg-surface-2 px-4 py-2 text-sm text-status-warn">
      Canlı bağlantı kesildi, yeniden deneniyor… Veriler 15 saniyede bir yenilenir.
    </div>
  );
}

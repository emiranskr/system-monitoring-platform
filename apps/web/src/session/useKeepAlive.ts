import { useEffect, useRef } from "react";
import { MeSchema } from "@sysmon/protocol";
import { apiFetch, SessionExpiredError } from "../api/client";

export const KEEP_ALIVE_MS = 5 * 60_000;

/**
 * Sunucu 30 dk bosta kuralini uygular; acik SSE akisi oturumu canli TUTMAZ (M3a karari). Bu yuzden GORUNUR sekmede 5 dakikada
 * bir `/api/v1/me` cagrilir; sekme gizliyken cagrilmaz (gizli sekme oturumu uzatmaz). 401 gelirse `onExpired` cagrilir ve durur.
 */
export function useKeepAlive(onExpired: () => void, enabled = true): void {
  const cb = useRef(onExpired);
  cb.current = onExpired;
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      apiFetch("/api/v1/me", MeSchema).catch((e) => {
        if (e instanceof SessionExpiredError) { clearInterval(id); cb.current(); }
        // ag hatasi vb.: sessizce gec, bir sonraki turda yeniden dener
      });
    }, KEEP_ALIVE_MS);
    return () => clearInterval(id);
  }, [enabled]);
}

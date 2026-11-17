import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { POLL_MS } from "./queries";

/**
 * Yasayan veri icin SABIT zamanlayicili yoklama: gorunur sekmede her `intervalMs`'de TUM aktif sorgular yeniden cekilir.
 * Neden sorgu basina `refetchInterval` DEGIL: TanStack Query her onbellek guncellemesinde (setQueryData) o zamanlayiciyi
 * sifirlar; SSE olaylari onbellegi 4-5 sn'de bir guncelledigi icin 15 sn'lik yoklama HIC atesllenmezdi (gercek tarayicida
 * E2E ile bulundu): cihazin sessizce cevrimdisi olmasi (SSE olayi uretmez) ve oturum kaybi fark edilmezdi.
 */
export function usePolling(intervalMs: number = POLL_MS): void {
  const qc = useQueryClient();
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void qc.refetchQueries({ type: "active" });
    }, intervalMs);
    return () => clearInterval(id);
  }, [qc, intervalMs]);
}

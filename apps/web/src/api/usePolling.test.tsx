import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePolling } from "./usePolling";

/**
 * REGRESYON (E2E'de gercek tarayicida bulundu): TanStack Query, her onbellek guncellemesinde (setQueryData) per-sorgu
 * `refetchInterval` zamanlayicisini SIFIRLAR. SSE olaylari onbellegi 4-5 sn'de bir guncelledigi icin 15 sn'lik yoklama HIC
 * ATESLENMIYORDU (durum gecisleri ve oturum kaybi fark edilmiyordu). Yoklama artik onbellek yazimlarindan bagimsiz sabit zamanlayicidir.
 */
const setVisibility = (v: "visible" | "hidden") => Object.defineProperty(document, "visibilityState", { value: v, configurable: true });

function Probe({ fetcher }: { fetcher: () => Promise<number> }) {
  usePolling(15_000);
  useQuery({ queryKey: ["probe"], queryFn: fetcher, staleTime: 0 });
  return null;
}

let qc: QueryClient;
beforeEach(() => { vi.useFakeTimers(); setVisibility("visible"); qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }); });
afterEach(() => { vi.useRealTimers(); setVisibility("visible"); });

const mount = (fetcher: () => Promise<number>) => render(<QueryClientProvider client={qc}><Probe fetcher={fetcher} /></QueryClientProvider>);
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe("usePolling", () => {
  it("her 15 sn'de aktif sorgulari yeniden ceker", async () => {
    const fetcher = vi.fn(async () => 1);
    mount(fetcher);
    await advance(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await advance(15_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await advance(15_000);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("SIK onbellek guncellemeleri (SSE olaylari gibi, 4 sn'de bir) yoklamayi ACLIKTAN OLDURMEZ", async () => {
    const fetcher = vi.fn(async () => 1);
    mount(fetcher);
    await advance(0);
    for (let t = 0; t < 40_000; t += 4_000) {
      act(() => { qc.setQueryData(["probe"], (v: number | undefined) => (v ?? 0) + 1); }); // olay -> onbellek yazimi
      await advance(4_000);
    }
    expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(3); // 40 sn'de en az 2 yoklama (+ ilk cekme)
  });

  it("sekme GIZLIYKEN cekmez; gorunur olunca devam eder", async () => {
    const fetcher = vi.fn(async () => 1);
    mount(fetcher);
    await advance(0);
    setVisibility("hidden");
    await advance(60_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    await advance(15_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("unmount zamanlayiciyi temizler", async () => {
    const fetcher = vi.fn(async () => 1);
    const { unmount } = mount(fetcher);
    await advance(0);
    unmount();
    await advance(60_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    qc.clear(); // QueryClient'in kendi cop toplama zamanlayicilari haric: hook'un zamanlayicisi kalmamali
    expect(vi.getTimerCount()).toBe(0);
  });
});

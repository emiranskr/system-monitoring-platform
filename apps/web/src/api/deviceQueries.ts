import { useQuery } from "@tanstack/react-query";
import { DeviceDetailSchema, MetricNamesResponseSchema, MetricSeriesSchema } from "@sysmon/protocol";
import { rangeToWindow, type RangeId } from "../charts/range";
import { apiFetch } from "./client";
import { POLL_MS } from "./queries";

export const deviceKeys = {
  detail: (id: string) => ["device", id] as const,
  names: (id: string) => ["device", id, "metric-names"] as const,
  series: (id: string, metric: string, range: RangeId, maxPoints: number) => ["device", id, "series", metric, range, maxPoints] as const,
};

export function useDevice(id: string) {
  return useQuery({
    queryKey: deviceKeys.detail(id),
    queryFn: ({ signal }) => apiFetch(`/api/v1/devices/${encodeURIComponent(id)}`, DeviceDetailSchema, { signal }),
    refetchInterval: POLL_MS,
    retry: false, // 404 (bulunamadi) tekrar denenmez
  });
}

/** Metrik adlari gercek veriden kesfedilir (backend sozlesmesi: son 10 dk, en cok 200). Yeni metrikler 15 sn yoklamayla gorunur. */
export function useMetricNames(id: string) {
  return useQuery({
    queryKey: deviceKeys.names(id),
    queryFn: ({ signal }) => apiFetch(`/api/v1/devices/${encodeURIComponent(id)}/metric-names`, MetricNamesResponseSchema, { signal }),
    refetchInterval: POLL_MS,
  });
}

export function useMetricSeries(id: string, metric: string, range: RangeId, maxPoints: number) {
  return useQuery({
    queryKey: deviceKeys.series(id, metric, range, maxPoints),
    queryFn: ({ signal }) => {
      const w = rangeToWindow(range, new Date());
      const qs = new URLSearchParams({ metric, from: w.from, to: w.to, max_points: String(maxPoints) });
      return apiFetch(`/api/v1/devices/${encodeURIComponent(id)}/metrics?${qs}`, MetricSeriesSchema, { signal });
    },
    refetchInterval: POLL_MS,
    placeholderData: (prev) => prev, // aralik degisirken eski grafik gorunur (yanip sonme yok)
  });
}

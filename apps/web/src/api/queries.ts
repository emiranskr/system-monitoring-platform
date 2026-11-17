import { useQuery } from "@tanstack/react-query";
import { DevicesResponseSchema } from "@sysmon/protocol";
import { apiFetch } from "./client";

/** Yoklama araligi (usePolling): SSE varken de calisir, cunku cihazin sessizce cevrimdisi olmasi SSE olayi uretmez. */
export const POLL_MS = 15_000;

export const queryKeys = {
  devices: ["devices"] as const,
};

export function useDevices() {
  return useQuery({
    queryKey: queryKeys.devices,
    queryFn: ({ signal }) => apiFetch("/api/v1/devices", DevicesResponseSchema, { signal }),
  });
}

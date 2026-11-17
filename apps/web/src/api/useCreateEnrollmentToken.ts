import { useMutation } from "@tanstack/react-query";
import { EnrollmentTokenResponseSchema } from "@sysmon/protocol";
import { apiFetch } from "./client";

/**
 * Enrollment token uretimi (owner|admin). Token YALNIZCA bu mutasyonun sonucunda bulunur; `gcTime: 0` ile onbellekte tutulmaz,
 * diyalog kapaninca `reset()` cagrilir (bkz. AddDeviceDialog).
 */
export function useCreateEnrollmentToken() {
  return useMutation({
    gcTime: 0,
    mutationFn: (v: { ttl_minutes: number }) => apiFetch("/api/v1/enrollment-tokens", EnrollmentTokenResponseSchema, { method: "POST", json: v }),
  });
}

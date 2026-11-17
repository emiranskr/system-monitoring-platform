import { z } from "zod";
import { MetricNameSchema, MetricValueSchema } from "./ingest.js";
import { DeviceInfoSchema } from "./enroll.js";

/**
 * Panel API sozlesmesi (/api/v1). TEK DOGRULUK KAYNAGI: (1) on yuz her yaniti bu semayla calisma zamaninda dogrular,
 * (2) backend sozlesme testleri gercek yanitlari ayni semayla dogrular, (3) OpenAPI (docs/api/openapi.json) buradan uretilir.
 * Sekiller apps/api/src/{devices,metrics-query,users,enrollment-admin,stream}.ts ile birebir tutulur.
 */
const IsoTime = z.iso.datetime();

export const DeviceStatusSchema = z.enum(["online", "stale", "offline", "unknown", "revoked"]);
export type DeviceStatus = z.infer<typeof DeviceStatusSchema>;

export const DeviceSummarySchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  status: DeviceStatusSchema,
  last_seen_at: IsoTime.nullable(),
  cpu_pct: z.number().nullable(),
  mem_pct: z.number().nullable(),
  disk_used_pct: z.number().nullable(),
});
export type DeviceSummary = z.infer<typeof DeviceSummarySchema>;

export const DevicesResponseSchema = z.strictObject({ devices: z.array(DeviceSummarySchema) });
export type DevicesResponse = z.infer<typeof DevicesResponseSchema>;

export const DeviceDetailSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  status: DeviceStatusSchema,
  last_seen_at: IsoTime.nullable(),
  device_info: DeviceInfoSchema.nullable(),
});
export type DeviceDetail = z.infer<typeof DeviceDetailSchema>;

export const MetricPointSchema = z.strictObject({ t: IsoTime, avg: z.number().finite(), min: z.number().finite(), max: z.number().finite() });
export type MetricPoint = z.infer<typeof MetricPointSchema>;

export const MetricSeriesSchema = z.strictObject({
  metric: MetricNameSchema,
  from: IsoTime,
  to: IsoTime,
  source: z.enum(["raw", "1m"]),
  bucket_seconds: z.number().int().positive(),
  points: z.array(MetricPointSchema),
});
export type MetricSeries = z.infer<typeof MetricSeriesSchema>;

/** Bir cihaz icin metrik adi kesfi ust siniri (backend ve on yuz ayni sabiti kullanir). */
export const MAX_METRIC_NAMES = 200;
export const MetricNamesResponseSchema = z.strictObject({
  metrics: z.array(z.strictObject({ name: MetricNameSchema, last_ts: IsoTime })).max(MAX_METRIC_NAMES),
});
export type MetricNamesResponse = z.infer<typeof MetricNamesResponseSchema>;

export const RoleSchema = z.enum(["owner", "admin", "viewer"]);
export const MeSchema = z.strictObject({ email: z.string(), role: RoleSchema });
export type Me = z.infer<typeof MeSchema>;
export const LoginResponseSchema = z.strictObject({ user: MeSchema });
export type LoginResponse = z.infer<typeof LoginResponseSchema>;
export const LoginRequestSchema = z.strictObject({ email: z.string().min(3).max(254), password: z.string().min(1).max(256) });

export const EnrollmentTokenRequestSchema = z.strictObject({ ttl_minutes: z.number().int().min(5).max(1440).optional() });
export const EnrollmentTokenResponseSchema = z.strictObject({ token: z.string().min(20), expires_at: IsoTime });
export type EnrollmentTokenResponse = z.infer<typeof EnrollmentTokenResponseSchema>;

/** SSE `sample` olayinin data govdesi (stream.ts). */
export const SampleEventPayloadSchema = z.strictObject({ device_id: z.uuid(), t: IsoTime, values: z.record(z.string(), MetricValueSchema) });
export type SampleEventPayload = z.infer<typeof SampleEventPayloadSchema>;

export const ApiErrorSchema = z.looseObject({ error: z.string() });
export type ApiError = z.infer<typeof ApiErrorSchema>;

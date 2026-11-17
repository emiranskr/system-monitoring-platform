import { describe, expect, it } from "vitest";
import {
  ApiErrorSchema, DeviceDetailSchema, DeviceStatusSchema, DeviceSummarySchema, DevicesResponseSchema, EnrollmentTokenResponseSchema,
  LoginResponseSchema, MAX_METRIC_NAMES, MeSchema, MetricNamesResponseSchema, MetricPointSchema, MetricSeriesSchema, SampleEventPayloadSchema,
} from "../src/index.js";

const UUID = "11111111-1111-4111-8111-111111111111";
const T = "2026-11-17T12:00:00.000Z";
const summary = { id: UUID, name: "pc-01", status: "online", last_seen_at: T, cpu_pct: 12.5, mem_pct: 61, disk_used_pct: 83 };
const info = { hostname: "pc-01", os: "Windows 11", agent_version: "0.1.0", gpus: [], adapters: [{ id: "a", name: "Ethernet" }], volumes: [{ id: "C", name: "C:" }] };

describe("panel API semalari (sozlesme)", () => {
  it("DeviceSummary: gecerli ornek kabul; null alanlar gecerli; bilinmeyen alan, yanlis tip, uuid olmayan id, bilinmeyen durum reddedilir", () => {
    expect(DeviceSummarySchema.safeParse(summary).success).toBe(true);
    expect(DeviceSummarySchema.safeParse({ ...summary, last_seen_at: null, cpu_pct: null, mem_pct: null, disk_used_pct: null, status: "unknown" }).success).toBe(true);
    for (const bad of [{ ...summary, extra: 1 }, { ...summary, cpu_pct: "12" }, { ...summary, id: "abc" }, { ...summary, status: "bozuk" }, { ...summary, name: undefined }]) {
      expect(DeviceSummarySchema.safeParse(bad).success).toBe(false);
    }
  });

  it("DeviceStatus tam olarak bes durum", () => {
    expect(DeviceStatusSchema.options).toEqual(["online", "stale", "offline", "unknown", "revoked"]);
  });

  it("DevicesResponse: bos liste gecerli", () => {
    expect(DevicesResponseSchema.safeParse({ devices: [] }).success).toBe(true);
    expect(DevicesResponseSchema.safeParse({ devices: [summary] }).success).toBe(true);
    expect(DevicesResponseSchema.safeParse({}).success).toBe(false);
  });

  it("DeviceDetail: device_info DeviceInfoSchema veya null", () => {
    const d = { id: UUID, name: "pc", status: "stale", last_seen_at: T, device_info: info };
    expect(DeviceDetailSchema.safeParse(d).success).toBe(true);
    expect(DeviceDetailSchema.safeParse({ ...d, device_info: null }).success).toBe(true);
    expect(DeviceDetailSchema.safeParse({ ...d, device_info: { hostname: "x" } }).success).toBe(false);
  });

  it("MetricSeries: kaynak raw|1m, bucket_seconds pozitif tam sayi, nokta min<=avg<=max sirasi sozlesmede zorunlu degil ama sayilar sonlu", () => {
    const pt = { t: T, avg: 1, min: 0, max: 2 };
    const s = { metric: "cpu.total", from: T, to: T, source: "raw", bucket_seconds: 10, points: [pt] };
    expect(MetricSeriesSchema.safeParse(s).success).toBe(true);
    expect(MetricSeriesSchema.safeParse({ ...s, points: [] }).success).toBe(true); // bos aralik gecerli
    for (const bad of [{ ...s, source: "5m" }, { ...s, bucket_seconds: 0 }, { ...s, bucket_seconds: -5 }, { ...s, bucket_seconds: 1.5 }, { ...s, points: [{ ...pt, avg: NaN }] }, { ...s, points: [{ ...pt, avg: null }] }]) {
      expect(MetricSeriesSchema.safeParse(bad).success).toBe(false);
    }
    expect(MetricPointSchema.safeParse({ ...pt, extra: 1 }).success).toBe(false);
  });

  it("MetricNames: bos gecerli, en cok 200 oge, ad metrik adi bicimine uymali", () => {
    expect(MAX_METRIC_NAMES).toBe(200);
    expect(MetricNamesResponseSchema.safeParse({ metrics: [] }).success).toBe(true);
    expect(MetricNamesResponseSchema.safeParse({ metrics: [{ name: "cpu.total", last_ts: T }] }).success).toBe(true);
    const many = Array.from({ length: 201 }, (_, i) => ({ name: `a.m${i}`, last_ts: T }));
    expect(MetricNamesResponseSchema.safeParse({ metrics: many }).success).toBe(false);
    expect(MetricNamesResponseSchema.safeParse({ metrics: [{ name: "BOZUK AD", last_ts: T }] }).success).toBe(false);
  });

  it("Me / Login / EnrollmentToken / SampleEvent / ApiError", () => {
    expect(MeSchema.safeParse({ email: "a@example.com", role: "owner" }).success).toBe(true);
    expect(MeSchema.safeParse({ email: "a@example.com", role: "root" }).success).toBe(false);
    expect(LoginResponseSchema.safeParse({ user: { email: "a@example.com", role: "viewer" } }).success).toBe(true);
    expect(EnrollmentTokenResponseSchema.safeParse({ token: "x".repeat(43), expires_at: T }).success).toBe(true);
    expect(EnrollmentTokenResponseSchema.safeParse({ token: "kisa", expires_at: T }).success).toBe(false);
    expect(SampleEventPayloadSchema.safeParse({ device_id: UUID, t: T, values: { "cpu.total": 1, "gpu.temp": null } }).success).toBe(true);
    expect(SampleEventPayloadSchema.safeParse({ device_id: UUID, t: T, values: { "cpu.total": "1" } }).success).toBe(false);
    expect(ApiErrorSchema.safeParse({ error: "unauthorized" }).success).toBe(true);
    expect(ApiErrorSchema.safeParse({}).success).toBe(false);
  });
});

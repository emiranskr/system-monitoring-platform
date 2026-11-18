import { describe, expect, it } from "vitest";
import {
  AlertRuleInputSchema, AlertRulePatchSchema, ChannelInputSchema, IncidentsQuerySchema, isAllowedAlertMetric,
} from "../src/index.js";

const rule = (over: Record<string, unknown> = {}) => ({
  name: "CPU", metric: "cpu.total", agg: "avg", window_seconds: 60, operator: ">", threshold: 90, for_seconds: 120, severity: "warning", ...over,
});

describe("uyari metrik izin listesi", () => {
  it.each([
    "cpu.total", "mem.used_pct", "disk.c.used_pct", "disk.*.used_pct", "net.eth0.rx_bps", "net.*.tx_bps", "device.offline", "sensor.cpu_package_temp_c",
    "gpu.gpu-46139694-b075-6c98-9b95-3b6f3a465823.temp_c", "gpu.*.util_pct", "gpu.pci-0000-01-00-0.vram_used_bytes",
  ])("%s izinli", (m) => { expect(isAllowedAlertMetric(m)).toBe(true); });

  it.each([
    "", "cpu", "cpu.total ", "cpu.total' OR '1'='1", "cpu.total;DROP TABLE x", "disk.*.*.used_pct", "disk.c.d.used_pct", "gpu.*.bilinmeyen", "sensor.x",
    "%", "cpu.%", "a".repeat(65), "mem.total_bytes", "../etc/passwd", "disk.\\.used_pct",
  ])("%j reddedilir", (m) => { expect(isAllowedAlertMetric(m)).toBe(false); });

  it("string olmayan degerler reddedilir", () => {
    for (const v of [null, undefined, 1, {}, ["cpu.total"]]) expect(isAllowedAlertMetric(v)).toBe(false);
  });
});

describe("kural girdisi", () => {
  it("gecerli kural kabul; varsayilanlar (histerezis 0, kapsam tum cihazlar, kanal yok, etkin)", () => {
    const r = AlertRuleInputSchema.parse(rule());
    expect(r).toMatchObject({ hysteresis: 0, scope_device_ids: null, channel_ids: [], enabled: true });
  });

  it.each([
    ["izin disi operator", { operator: "!=" }], ["izin disi agg", { agg: "median" }], ["izin disi metrik", { metric: "x.y" }],
    ["pencere kisa", { window_seconds: 5 }], ["pencere uzun", { window_seconds: 3601 }], ["negatif for", { for_seconds: -1 }],
    ["NaN esik", { threshold: NaN }], ["sonsuz esik", { threshold: Infinity }], ["negatif histerezis", { hysteresis: -1 }],
    ["izin disi onem", { severity: "fatal" }], ["bos ad", { name: "   " }], ["uzun ad", { name: "a".repeat(101) }],
    ["bilinmeyen alan", { builtin: "offline" }], ["cok kapsam", { scope_device_ids: Array.from({ length: 201 }, () => "00000000-0000-4000-8000-000000000000") }],
    ["gecersiz kanal id", { channel_ids: ["x"] }],
  ])("%s reddedilir", (_n, over) => { expect(AlertRuleInputSchema.safeParse(rule(over)).success).toBe(false); });

  it("kismi guncelleme: en az bir alan zorunlu; alan dogrulamasi ayni", () => {
    expect(AlertRulePatchSchema.safeParse({}).success).toBe(false);
    expect(AlertRulePatchSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(AlertRulePatchSchema.safeParse({ operator: "~" }).success).toBe(false);
    expect(AlertRulePatchSchema.safeParse({ metric: "cpu.total'--" }).success).toBe(false);
    // PATCH varsayilan UYGULAMAZ: yalniz verilen alanlar doner
    expect(AlertRulePatchSchema.parse({ enabled: false })).toEqual({ enabled: false });
  });
});

describe("kanal girdisi / sorgu", () => {
  it("webhook ve e-posta girdisi; tur ayrimi", () => {
    expect(ChannelInputSchema.safeParse({ type: "webhook", name: "w", url: "https://hooks.example.com/abc" }).success).toBe(true);
    expect(ChannelInputSchema.safeParse({ type: "email", name: "e", host: "smtp.example.com", port: 587, from: "a@example.com", to: ["b@example.com"] }).success).toBe(true);
    expect(ChannelInputSchema.safeParse({ type: "sms", name: "x" }).success).toBe(false);
    expect(ChannelInputSchema.safeParse({ type: "webhook", name: "w", url: "https://x.example.com", extra: 1 }).success).toBe(false);
    expect(ChannelInputSchema.safeParse({ type: "email", name: "e", host: "h", port: 70000, from: "a@example.com", to: ["b@example.com"] }).success).toBe(false);
    expect(ChannelInputSchema.safeParse({ type: "email", name: "e", host: "h", port: 25, from: "a@example.com", to: [] }).success).toBe(false);
  });
  it("olay sorgusu: varsayilanlar ve sinirlar", () => {
    expect(IncidentsQuerySchema.parse({})).toEqual({ state: "all", limit: 50 });
    expect(IncidentsQuerySchema.parse({ state: "open", limit: "10" })).toEqual({ state: "open", limit: 10 });
    expect(IncidentsQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(IncidentsQuerySchema.safeParse({ limit: 201 }).success).toBe(false);
    expect(IncidentsQuerySchema.safeParse({ state: "x" }).success).toBe(false);
  });
});

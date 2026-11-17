import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { IngestRequestSchema, METRIC_NAME_RE, MetricNameSchema } from "../src/index.js";

const golden = () =>
  JSON.parse(readFileSync(new URL("./golden/ingest-valid.json", import.meta.url), "utf8"));

describe("IngestRequestSchema", () => {
  it("gecerli altin payload kabul edilir", () => {
    expect(IngestRequestSchema.safeParse(golden()).success).toBe(true);
  });
  it("desteklenmeyen metrik icin null kabul edilir", () => {
    const p = golden();
    expect(p.samples[0].m["gpu.GPU-8a1f.temp"]).toBeNull();
    expect(IngestRequestSchema.safeParse(p).success).toBe(true);
  });
  it("../etc metrik adi reddedilir", () => {
    const p = golden();
    p.samples[0].m = { "../etc": 1 };
    expect(IngestRequestSchema.safeParse(p).success).toBe(false);
  });
  it("65 karakterlik metrik adi reddedilir", () => {
    const p = golden();
    p.samples[0].m = { ["cpu." + "a".repeat(61)]: 1 };
    expect(IngestRequestSchema.safeParse(p).success).toBe(false);
  });
  it("1001 ornek reddedilir", () => {
    const p = golden();
    p.samples = Array.from({ length: 1001 }, () => p.samples[0]);
    expect(IngestRequestSchema.safeParse(p).success).toBe(false);
  });
  it("Infinity reddedilir", () => {
    const p = golden();
    p.samples[0].m = { "cpu.total": Infinity };
    expect(IngestRequestSchema.safeParse(p).success).toBe(false);
  });
  it("v:2 reddedilir", () => {
    const p = golden();
    p.v = 2;
    expect(IngestRequestSchema.safeParse(p).success).toBe(false);
  });
  it("govdede device_id (eslesse de) reddedilir", () => {
    const p = { ...golden(), device_id: "11111111-1111-4111-8111-111111111111" };
    expect(IngestRequestSchema.safeParse(p).success).toBe(false);
  });
  it("METRIC_NAME_RE cpu.total kabul eder", () => {
    expect(METRIC_NAME_RE.test("cpu.total")).toBe(true);
  });
});

describe("M4 GPU/sensor metrik adlari (ajan GpuCollector/SensorCollector ile ayni kurallar)", () => {
  const id = "gpu-46139694-b075-6c98-9b95-3b6f3a465823"; // NVML UUID tabanli CanonicalId (40 karakter)
  const fields = ["util_pct", "vram_used_bytes", "vram_total_bytes", "temp_c", "power_w", "fan_pct", "core_clock_mhz", "mem_clock_mhz"];

  it("tum GPU alan adlari gecerli ve 64 karakteri asmaz", () => {
    for (const f of fields) {
      const name = `gpu.${id}.${f}`;
      expect(name.length).toBeLessThanOrEqual(64);
      expect(MetricNameSchema.safeParse(name).success, name).toBe(true);
    }
  });
  it("PCI tabanli kimlik ve sensor adlari gecerli", () => {
    expect(MetricNameSchema.safeParse("gpu.pci-0000-01-00-0.util_pct").success).toBe(true);
    for (const n of ["sensor.cpu_package_temp_c", "sensor.cpu_core_max_temp_c", "sensor.motherboard_temp_c", "sensor.cpu_fan_rpm"])
      expect(MetricNameSchema.safeParse(n).success, n).toBe(true);
  });
  it("kimlikte nokta/bosluk ve 64 karakter ustu reddedilir (kimlik 44 karakteri asamaz)", () => {
    expect(MetricNameSchema.safeParse("gpu.a.b.util_pct.x").success).toBe(false);
    expect(MetricNameSchema.safeParse("gpu.luid 0x1.util_pct").success).toBe(false);
    expect(MetricNameSchema.safeParse(`gpu.${"a".repeat(45)}.vram_used_bytes`).success).toBe(false); // 65 karakter
    expect(MetricNameSchema.safeParse(`gpu.${"a".repeat(44)}.vram_used_bytes`).success).toBe(true); // tam 64
  });
});

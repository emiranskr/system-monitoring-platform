import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { IngestRequestSchema, METRIC_NAME_RE } from "../src/index.js";

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

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildOpenApi } from "../src/index.js";

const FILE = resolve(__dirname, "../../../docs/api/openapi.json");

describe("OpenAPI 3.1 (zod'dan uretilir)", () => {
  const doc = buildOpenApi() as { openapi: string; paths: Record<string, Record<string, unknown>>; components: { schemas: Record<string, unknown> } };

  it("surum 3.1.x ve tum panel yollari/metodlari var", () => {
    expect(doc.openapi).toMatch(/^3\.1\./);
    const have = Object.entries(doc.paths).flatMap(([p, ms]) => Object.keys(ms).map((m) => `${m.toUpperCase()} ${p}`)).sort();
    expect(have).toEqual([
      "GET /api/v1/devices", "GET /api/v1/devices/{id}", "GET /api/v1/devices/{id}/metric-names", "GET /api/v1/devices/{id}/metrics",
      "GET /api/v1/me", "GET /api/v1/stream", "POST /api/v1/enrollment-tokens", "POST /api/v1/login", "POST /api/v1/logout",
    ].sort());
  });

  it("sema bilesenleri JSON Schema'ya cevrilmis ve yollar onlara basvurur", () => {
    for (const name of ["DeviceSummary", "DevicesResponse", "DeviceDetail", "MetricSeries", "MetricNamesResponse", "Me", "LoginResponse", "EnrollmentTokenResponse", "SampleEventPayload", "ApiError"]) {
      expect(doc.components.schemas[name], name).toBeTypeOf("object");
    }
    expect(JSON.stringify(doc.paths)).toContain("#/components/schemas/DevicesResponse");
  });

  it("docs/api/openapi.json GUNCEL (uretilenle birebir ayni; degisince `pnpm --filter @sysmon/protocol gen:openapi` calistir)", () => {
    const committed = JSON.parse(readFileSync(FILE, "utf8"));
    expect(committed).toEqual(JSON.parse(JSON.stringify(doc)));
  });
});

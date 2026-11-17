import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ApiErrorSchema, DeviceDetailSchema, DevicesResponseSchema, EnrollmentTokenResponseSchema, LoginResponseSchema, MeSchema,
  MetricNamesResponseSchema, MetricSeriesSchema,
} from "@sysmon/protocol";
import { addUser, api, cookieFrom, setupKit, type Kit } from "./kit.js";

/**
 * SOZLESME TESTI: M3a'nin gercek /api/v1 yanitlari packages/protocol zod semalariyla (strictObject: fazladan alan da hata)
 * dogrulanir. Backend yaniti degisirse bu test kirilir; on yuz yalniz bu semalara guvenir.
 */
const PW = "yeterince-uzun-parola-1";
const MIN = 60_000, HOUR = 3600_000;
let k: Kit;
let cookie = "", devId = "", T: Date;

beforeAll(async () => {
  T = new Date(Math.floor(Date.now() / MIN) * MIN);
  k = await setupKit();
  k.clock.now = T;
  const q = (sql: string, p: unknown[] = []) => k.db.pool.query(sql, p);
  devId = (await q("INSERT INTO devices (org_id, name, last_seen_at, device_info) VALUES ($1,'pc-01',$2,$3) RETURNING id",
    [k.org, new Date(T.getTime() - 5_000), JSON.stringify({ hostname: "pc-01", os: "Windows 11", agent_version: "0.1.0", gpus: [], adapters: [{ id: "a", name: "Ethernet" }], volumes: [{ id: "C", name: "C:" }] })])).rows[0].id;
  await q("INSERT INTO devices (org_id, name) VALUES ($1,'bos-cihaz')", [k.org]); // device_info null, hic gorulmemis
  await q(`INSERT INTO metric_samples (ts, org_id, device_id, metric, value)
           SELECT t, $1, $2, m, (extract(epoch from t)::bigint % 100)
             FROM generate_series($3::timestamptz, $4::timestamptz, interval '5 seconds') t, unnest(ARRAY['cpu.total','mem.used_pct','disk.c.used_pct']) m`,
    [k.org, devId, new Date(T.getTime() - 40 * MIN), new Date(T.getTime() - 5_000)]);
  await q(`INSERT INTO metric_samples (ts, org_id, device_id, metric, value)
           SELECT t, $1, $2, 'cpu.total', 50 FROM generate_series($3::timestamptz, $4::timestamptz, interval '1 minute') t`,
    [k.org, devId, new Date(T.getTime() - 5 * HOUR), new Date(T.getTime() - 41 * MIN)]);
  await q("CALL refresh_continuous_aggregate('metric_1m', $1::timestamptz, $2::timestamptz)", [new Date(T.getTime() - 6 * HOUR), new Date(T.getTime() - MIN)]);
  await addUser(k, "admin@example.com", PW, "admin");
  const r = await api(k, "POST", "/api/v1/login", { body: { email: "admin@example.com", password: PW } });
  LoginResponseSchema.parse(r.json());
  cookie = cookieFrom(r)!;
}, 180_000);
afterAll(async () => { await k?.close(); });

const get = (path: string) => api(k, "GET", path, { cookie });
const range = (spanMs: number) => `from=${new Date(T.getTime() - spanMs).toISOString()}&to=${T.toISOString()}`;

describe("panel API sozlesmesi (gercek yanitlar zod semalariyla dogrulanir)", () => {
  it("POST /login -> LoginResponse; GET /me -> Me", async () => {
    const r = await api(k, "POST", "/api/v1/login", { body: { email: "admin@example.com", password: PW } });
    expect(r.statusCode).toBe(200);
    expect(LoginResponseSchema.parse(r.json()).user.role).toBe("admin");
    expect(MeSchema.parse((await get("/api/v1/me")).json()).email).toBe("admin@example.com");
  });

  it("GET /devices -> DevicesResponse (hic gorulmemis cihaz dahil)", async () => {
    const j = DevicesResponseSchema.parse((await get("/api/v1/devices")).json());
    expect(j.devices.map((d) => d.name).sort()).toEqual(["bos-cihaz", "pc-01"]);
    expect(j.devices.find((d) => d.name === "bos-cihaz")).toMatchObject({ status: "unknown", last_seen_at: null, cpu_pct: null });
  });

  it("GET /devices/:id -> DeviceDetail (device_info dolu ve null)", async () => {
    const j = DeviceDetailSchema.parse((await get(`/api/v1/devices/${devId}`)).json());
    expect(j.device_info?.hostname).toBe("pc-01");
    const list = DevicesResponseSchema.parse((await get("/api/v1/devices")).json());
    const emptyId = list.devices.find((d) => d.name === "bos-cihaz")!.id;
    expect(DeviceDetailSchema.parse((await get(`/api/v1/devices/${emptyId}`)).json()).device_info).toBeNull();
  });

  it("GET /devices/:id/metrics -> MetricSeries: ham (1 sa), 1 dk katmani (24 sa), bos aralik", async () => {
    const raw = MetricSeriesSchema.parse((await get(`/api/v1/devices/${devId}/metrics?metric=cpu.total&${range(HOUR)}`)).json());
    expect(raw.source).toBe("raw");
    expect(raw.points.length).toBeGreaterThan(0);
    const agg = MetricSeriesSchema.parse((await get(`/api/v1/devices/${devId}/metrics?metric=cpu.total&${range(24 * HOUR)}`)).json());
    expect(agg.source).toBe("1m");
    expect(agg.points.length).toBeGreaterThan(0);
    const empty = MetricSeriesSchema.parse((await get(`/api/v1/devices/${devId}/metrics?metric=yok.metrik&${range(HOUR)}`)).json());
    expect(empty.points).toEqual([]);
  });

  it("GET /devices/:id/metric-names -> MetricNamesResponse", async () => {
    const j = MetricNamesResponseSchema.parse((await get(`/api/v1/devices/${devId}/metric-names`)).json());
    expect(j.metrics.map((m) => m.name)).toEqual(["cpu.total", "disk.c.used_pct", "mem.used_pct"]);
  });

  it("POST /enrollment-tokens -> EnrollmentTokenResponse", async () => {
    const r = await api(k, "POST", "/api/v1/enrollment-tokens", { body: { ttl_minutes: 30 }, cookie });
    expect(r.statusCode).toBe(201);
    EnrollmentTokenResponseSchema.parse(r.json());
  });

  it("hata govdeleri ApiError semasina uyar (401, 403, 404, 400)", async () => {
    const r401 = await api(k, "GET", "/api/v1/devices");
    const r403 = await api(k, "POST", "/api/v1/enrollment-tokens", { body: {}, cookie, origin: "https://kotu.example" });
    const r404 = await get("/api/v1/devices/00000000-0000-4000-8000-000000000000");
    const r400 = await get(`/api/v1/devices/${devId}/metrics?metric=cpu.total&from=dun&to=bugun`);
    expect([r401.statusCode, r403.statusCode, r404.statusCode, r400.statusCode]).toEqual([401, 403, 404, 400]);
    for (const r of [r401, r403, r404, r400]) ApiErrorSchema.parse(r.json());
  });
});

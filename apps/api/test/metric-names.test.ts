import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MetricNamesResponseSchema } from "@sysmon/protocol";
import { addUser, api, loginAs, setupKit, type Kit } from "./kit.js";

const PW = "yeterince-uzun-parola-1";
const MIN = 60_000;
let k: Kit;
let orgB = "", devA = "", devEmpty = "", devB = "";
let cookie = "";
const names = async (id: string, c = cookie) => api(k, "GET", `/api/v1/devices/${id}/metric-names`, { cookie: c });
const put = (dev: string, org: string, metric: string, ageMs: number, v: number | null = 1) =>
  k.db.pool.query("INSERT INTO metric_samples (ts, org_id, device_id, metric, value) VALUES ($1,$2,$3,$4,$5)", [new Date(k.clock.now.getTime() - ageMs), org, dev, metric, v]);

beforeAll(async () => {
  k = await setupKit();
  const q = (sql: string, p: unknown[] = []) => k.db.pool.query(sql, p);
  orgB = (await q("INSERT INTO orgs (name) VALUES ('B') RETURNING id")).rows[0].id;
  devA = (await q("INSERT INTO devices (org_id, name) VALUES ($1,'a') RETURNING id", [k.org])).rows[0].id;
  devEmpty = (await q("INSERT INTO devices (org_id, name) VALUES ($1,'bos') RETURNING id", [k.org])).rows[0].id;
  devB = (await q("INSERT INTO devices (org_id, name) VALUES ($1,'b') RETURNING id", [orgB])).rows[0].id;
  await addUser(k, "u@example.com", PW, "viewer");
  cookie = await loginAs(k, "u@example.com", PW);
}, 120_000);
afterAll(async () => { await k?.close(); });

describe("GET /api/v1/devices/:id/metric-names", () => {
  it("oturumsuz 401; kodlu yolla da 401", async () => {
    expect((await api(k, "GET", `/api/v1/devices/${devA}/metric-names`)).statusCode).toBe(401);
    expect((await api(k, "GET", `/api/v1/devices/${devA}/metric-names`.replace("/api/v1/", "/api/v%31/"))).statusCode).toBe(401);
  });

  it("yalniz SON 10 DK'da veri gelen metrikler; son ornek zamani last_ts; ada gore sirali (deterministik)", async () => {
    await put(devA, k.org, "mem.used_pct", 2 * MIN);
    await put(devA, k.org, "cpu.total", 3 * MIN); await put(devA, k.org, "cpu.total", 30_000); // son ornek 30 sn once
    await put(devA, k.org, "disk.c.used_pct", 9 * MIN);
    await put(devA, k.org, "eski.metrik", 11 * MIN); // 10 dk disinda
    const r = await names(devA);
    expect(r.statusCode).toBe(200);
    const j = MetricNamesResponseSchema.parse(r.json());
    expect(j.metrics.map((m) => m.name)).toEqual(["cpu.total", "disk.c.used_pct", "mem.used_pct"]);
    expect(j.metrics.find((m) => m.name === "cpu.total")!.last_ts).toBe(new Date(k.clock.now.getTime() - 30_000).toISOString());
    expect(j.metrics.map((m) => m.name)).not.toContain("eski.metrik");
    // tekrarlanan cagri ayni sirayi verir
    expect((await names(devA)).json()).toEqual(r.json());
  });

  it("siralama BAYT duzeninde (COLLATE C): buyuk harf kucuk harften ONCE; yerel ayara bagli degil", async () => {
    const dev = (await k.db.pool.query("INSERT INTO devices (org_id, name) VALUES ($1,'sira') RETURNING id", [k.org])).rows[0].id as string;
    for (const n of ["case.alpha", "case.Zeta", "case._under", "case.beta"]) await put(dev, k.org, n, 5_000);
    const got = MetricNamesResponseSchema.parse((await names(dev)).json()).metrics.map((m) => m.name);
    expect(got).toEqual(["case.Zeta", "case._under", "case.alpha", "case.beta"]); // 'Z'(0x5A) < '_'(0x5F) < 'a'(0x61)
  });

  it("NULL degerli ornek de metrik sayilir (donanim 'yok' bilgisi degil, ornek geldi)", async () => {
    await put(devA, k.org, "gpu.temp", 20_000, null);
    const j = MetricNamesResponseSchema.parse((await names(devA)).json());
    expect(j.metrics.map((m) => m.name)).toContain("gpu.temp");
  });

  it("veri olmayan cihaz: 200 ve bos liste (gecerli yanit)", async () => {
    const r = await names(devEmpty);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ metrics: [] });
  });

  it("250 metrik: en cok 200 doner ve yine ada gore sirali (ilk 200)", async () => {
    const dev = (await k.db.pool.query("INSERT INTO devices (org_id, name) VALUES ($1,'cok') RETURNING id", [k.org])).rows[0].id as string;
    await k.db.pool.query(
      `INSERT INTO metric_samples (ts, org_id, device_id, metric, value)
       SELECT $1, $2, $3, 'many.m' || lpad(i::text, 3, '0'), 1 FROM generate_series(0, 249) i`, [new Date(k.clock.now.getTime() - 10_000), k.org, dev]);
    const j = MetricNamesResponseSchema.parse((await names(dev)).json());
    expect(j.metrics).toHaveLength(200);
    const got = j.metrics.map((m) => m.name);
    expect(got).toEqual([...got].sort());
    expect(got[0]).toBe("many.m000");
    expect(got[199]).toBe("many.m199");
  });

  it("BASKA org'un cihazi 404 = olmayan cihaz 404 (ayni govde); uuid olmayan 404; B'nin metrik adi sizmaz", async () => {
    await put(devB, orgB, "gizli.b_metrigi", 10_000);
    const other = await names(devB);
    const missing = await names("00000000-0000-4000-8000-000000000000");
    expect(other.statusCode).toBe(404);
    expect(other.body).toBe(missing.body);
    expect(other.body).not.toContain("gizli");
    expect((await names("abc")).statusCode).toBe(404);
    // A cihazinin listesinde B'nin metrigi yok
    expect((await names(devA)).body).not.toContain("gizli");
  });
});

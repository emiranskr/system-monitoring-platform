import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chooseSource, bucketSeconds } from "../src/metrics-query.js";
import { addUser, api, loginAs, setupKit, type Kit } from "./kit.js";

const PW = "yeterince-uzun-parola-1";
const MIN = 60_000, HOUR = 3600_000, DAY = 24 * HOUR;
let k: Kit;
let devA = "", devB = "", cookie = "";
let WBASE: Date;
let T: Date; // gercek "simdi" (cagg/saklama politikalari gercek saate gore calisir)
const iso = (d: Date) => d.toISOString();
const url = (id: string, q: Record<string, string | number>) => `/api/v1/devices/${id}/metrics?` + new URLSearchParams(Object.entries(q).map(([a, b]) => [a, String(b)])).toString();

beforeAll(async () => {
  T = new Date(Math.floor(Date.now() / MIN) * MIN);
  k = await setupKit();
  k.clock.now = T;
  const q = (sql: string, p: unknown[] = []) => k.db.pool.query(sql, p);
  const orgB = (await q("INSERT INTO orgs (name) VALUES ('B') RETURNING id")).rows[0].id;
  devA = (await q("INSERT INTO devices (org_id, name) VALUES ($1,'a') RETURNING id", [k.org])).rows[0].id;
  devB = (await q("INSERT INTO devices (org_id, name) VALUES ($1,'b') RETURNING id", [orgB])).rows[0].id;
  // Ham: son 10 dk, 5 sn araliklarla, cpu.total = saniye % 100; arada 3 dk BOSLUK (T-8dk .. T-5dk arasi veri yok).
  await q(`INSERT INTO metric_samples (ts, org_id, device_id, metric, value)
           SELECT t, $1, $2, 'cpu.total', (extract(epoch from t)::bigint % 100)
             FROM generate_series($3::timestamptz, $4::timestamptz, interval '5 seconds') t
            WHERE NOT (t > $5::timestamptz AND t < $6::timestamptz)`,
    [k.org, devA, new Date(T.getTime() - 10 * MIN), new Date(T.getTime() - 5_000), new Date(T.getTime() - 8 * MIN), new Date(T.getTime() - 5 * MIN)]);
  // Baska org'un cihazi: AYIRT EDILEBILIR deger (1234; hicbir gercek cpu degeri 100'u gecmez) hem ham hem 1m'de.
  await q("INSERT INTO metric_samples (ts, org_id, device_id, metric, value) VALUES ($1,$2,$3,'cpu.total',1234)", [new Date(T.getTime() - 20_000), orgB, devB]);
  await q("INSERT INTO metric_samples (ts, org_id, device_id, metric, value) VALUES ($1,$2,$3,'mem.used_pct',1234)", [new Date(T.getTime() - 2 * HOUR), orgB, devB]);
  // Katman agirligi: 180 sn'lik hizali kovada dakika0'da 1 ornek (deger 0), dakika1'de 9 ornek (deger 10) -> agirlikli ortalama 9 (agirliksiz 5).
  WBASE = new Date(Math.floor((T.getTime() - 2 * HOUR) / 180_000) * 180_000);
  await q("INSERT INTO metric_samples (ts, org_id, device_id, metric, value) VALUES ($1,$2,$3,'weighted.x',0)", [new Date(WBASE.getTime() + 10_000), k.org, devA]);
  for (let i = 0; i < 9; i++) await q("INSERT INTO metric_samples (ts, org_id, device_id, metric, value) VALUES ($1,$2,$3,'weighted.x',10)", [new Date(WBASE.getTime() + 60_000 + i * 5_000), k.org, devA]);
  // 1 dk katmani: son 25 saat, dakikada bir ham ornek (deger = dakika % 50); sonra cagg'i yenile.
  await q(`INSERT INTO metric_samples (ts, org_id, device_id, metric, value)
           SELECT t, $1, $2, 'mem.used_pct', (extract(epoch from t)::bigint / 60 % 50)
             FROM generate_series($3::timestamptz, $4::timestamptz, interval '1 minute') t`,
    [k.org, devA, new Date(T.getTime() - 25 * HOUR), new Date(T.getTime() - 3 * MIN)]);
  await q("CALL refresh_continuous_aggregate('metric_1m', $1::timestamptz, $2::timestamptz)", [new Date(T.getTime() - 26 * HOUR), new Date(T.getTime() - MIN)]);
  expect(WBASE.getTime()).toBeLessThan(T.getTime() - MIN);
  await addUser(k, "u@example.com", PW, "viewer");
  cookie = await loginAs(k, "u@example.com", PW);
}, 180_000);
afterAll(async () => { await k?.close(); });

describe("kaynak ve kova secimi", () => {
  const now = new Date("2026-11-15T12:00:00Z");
  it.each([
    [10 * MIN, 1 * HOUR, "raw"], [3 * HOUR, 3 * HOUR, "raw"], [4 * HOUR, 3 * HOUR + 1000, "1m"], // aralik > 3 sa -> 1m
    [2 * DAY, 1 * HOUR, "raw"], [4 * DAY, 1 * HOUR, "1m"], // from 3 gunden eski -> 1m (ham saklama 3 gun)
  ])("from=now-%i ms, aralik=%i ms -> %s", (fromAgo, range, want) => {
    const from = new Date(now.getTime() - fromAgo);
    expect(chooseSource(from, new Date(from.getTime() + range), now)).toBe(want);
  });
  it("kova: araligi max_points'e boler, kaynagin cozunurlugunun altina inmez, 1m icin 60 sn'nin kati", () => {
    expect(bucketSeconds(3600, 600, "raw")).toBe(6);
    expect(bucketSeconds(60, 600, "raw")).toBe(1);
    expect(bucketSeconds(86400, 600, "1m")).toBe(180); // 144 -> 180 (60 kati)
    expect(bucketSeconds(1800, 600, "1m")).toBe(60); // 3 -> en az 60
  });
});

describe("GET /api/v1/devices/:id/metrics", () => {
  it("oturumsuz 401", async () => {
    expect((await api(k, "GET", url(devA, { metric: "cpu.total", from: iso(new Date(T.getTime() - HOUR)), to: iso(T) }))).statusCode).toBe(401);
  });

  it("ham aralik: avg/min/max elle hesaplananla eslesir, bosluk icin nokta URETILMEZ", async () => {
    const from = new Date(T.getTime() - 10 * MIN), to = T;
    const r = await api(k, "GET", url(devA, { metric: "cpu.total", from: iso(from), to: iso(to), max_points: 60 }), { cookie });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j).toMatchObject({ metric: "cpu.total", source: "raw", bucket_seconds: 10 });
    const pts = j.points as { t: string; avg: number; min: number; max: number }[];
    // 3 dk bosluk (T-8dk..T-5dk) icinde nokta yok
    for (const p of pts) { const t = new Date(p.t).getTime(); expect(t <= T.getTime() - 8 * MIN || t >= T.getTime() - 5 * MIN - 10_000).toBe(true); }
    // Elle hesap: ilk kova
    const b0 = new Date(pts[0]!.t).getTime();
    const vals = (await k.db.pool.query("SELECT value FROM metric_samples WHERE device_id=$1 AND metric='cpu.total' AND ts >= $2 AND ts < $3", [devA, new Date(b0), new Date(b0 + 10_000)])).rows.map((x) => x.value as number);
    expect(vals.length).toBeGreaterThan(0);
    expect(pts[0]!.avg).toBeCloseTo(vals.reduce((a, b) => a + b, 0) / vals.length, 6);
    expect(pts[0]!.min).toBe(Math.min(...vals));
    expect(pts[0]!.max).toBe(Math.max(...vals));
    expect(pts.length).toBeLessThanOrEqual(61);
  });

  it("24 saatlik aralik 1 dk katmanindan gelir ve max_points'i asmaz; degerler katmanla tutarli", async () => {
    const r = await api(k, "GET", url(devA, { metric: "mem.used_pct", from: iso(new Date(T.getTime() - 24 * HOUR)), to: iso(new Date(T.getTime() - 5 * MIN)), max_points: 300 }), { cookie });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.source).toBe("1m");
    expect(j.bucket_seconds % 60).toBe(0);
    expect(j.points.length).toBeGreaterThan(100);
    expect(j.points.length).toBeLessThanOrEqual(301);
    for (const p of j.points) { expect(p.min).toBeLessThanOrEqual(p.avg); expect(p.avg).toBeLessThanOrEqual(p.max); expect(p.min).toBeGreaterThanOrEqual(0); expect(p.max).toBeLessThan(50); }
  });

  it("1 dk katmaninda kovalar ORNEK SAYISIYLA agirliklandirilir (agirliksiz ortalama yanlis olurdu)", async () => {
    const r = await api(k, "GET", url(devA, { metric: "weighted.x", from: iso(WBASE), to: iso(new Date(WBASE.getTime() + 4 * HOUR)), max_points: 80 }), { cookie });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j).toMatchObject({ source: "1m", bucket_seconds: 180 });
    expect(j.points).toHaveLength(1);
    expect(j.points[0]).toMatchObject({ t: iso(WBASE), min: 0, max: 10 });
    expect(j.points[0].avg).toBeCloseTo(9, 6);
  });

  it("baska cihazin verisi (ham ve 1 dk) HICBIR noktaya karismaz", async () => {
    const raw = await api(k, "GET", url(devA, { metric: "cpu.total", from: iso(new Date(T.getTime() - HOUR)), to: iso(T), max_points: 10 }), { cookie });
    const agg = await api(k, "GET", url(devA, { metric: "mem.used_pct", from: iso(new Date(T.getTime() - 4 * HOUR)), to: iso(T), max_points: 100 }), { cookie });
    for (const r of [raw, agg]) {
      expect(r.statusCode).toBe(200);
      expect(r.json().points.length).toBeGreaterThan(0);
      for (const p of r.json().points) { expect(p.max).toBeLessThan(1000); }
    }
  });

  // M-4a (inceleme): ham sorgu kurali yalniz "aralik <= 3 sa ve from >= now-3 gun"; 12 sa sonrasi SIKISTIRILMIS ham chunk'lar da okunabilir.
  it("12 saatten eski, SIKISTIRILMIS ham chunk'taki aralik dogru okunur (ham kaynak)", async () => {
    const base = new Date(Math.floor((T.getTime() - 20 * HOUR) / MIN) * MIN);
    await k.db.pool.query(
      `INSERT INTO metric_samples (ts, org_id, device_id, metric, value)
       SELECT t, $1, $2, 'cmp.raw', 10 + (extract(epoch from t)::bigint % 5)
         FROM generate_series($3::timestamptz, $4::timestamptz, interval '5 seconds') t`,
      [k.org, devA, base, new Date(base.getTime() + 20 * MIN)]);
    for (const c of (await k.db.pool.query("SELECT show_chunks('metric_samples', older_than => now() - interval '13 hours') AS c")).rows) {
      try { await k.db.pool.query("SELECT compress_chunk($1::regclass, if_not_compressed => true)", [c.c]); }
      catch (e) { if (!/already compressed/.test((e as Error).message)) throw e; }
    }
    const nCompressed = Number((await k.db.pool.query("SELECT count(*) FROM timescaledb_information.chunks WHERE hypertable_name='metric_samples' AND is_compressed")).rows[0].count);
    expect(nCompressed).toBeGreaterThan(0);
    const r = await api(k, "GET", url(devA, { metric: "cmp.raw", from: iso(base), to: iso(new Date(base.getTime() + 20 * MIN)), max_points: 20 }), { cookie });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.source).toBe("raw");
    expect(j.points.length).toBeGreaterThan(10);
    for (const p of j.points) { expect(p.min).toBeGreaterThanOrEqual(10); expect(p.max).toBeLessThanOrEqual(14); }
  });

  it("veri olmayan aralik ve olmayan metrik: points bos dizi (hata degil, sahte nokta yok)", async () => {
    const empty = await api(k, "GET", url(devA, { metric: "cpu.total", from: iso(new Date(T.getTime() - 40 * DAY)), to: iso(new Date(T.getTime() - 39 * DAY)) }), { cookie });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().points).toEqual([]);
    const none = await api(k, "GET", url(devA, { metric: "yok.metrik", from: iso(new Date(T.getTime() - HOUR)), to: iso(T) }), { cookie });
    expect(none.statusCode).toBe(200);
    expect(none.json().points).toEqual([]);
  });

  it.each([
    ["from >= to", { from: "2026-11-15T12:00:00Z", to: "2026-11-15T12:00:00Z" }],
    ["from > to", { from: "2026-11-15T13:00:00Z", to: "2026-11-15T12:00:00Z" }],
    ["32 gunluk aralik", { from: "2026-10-01T00:00:00Z", to: "2026-11-02T00:00:00Z" }],
    ["gecersiz tarih", { from: "dun", to: "bugun" }],
    ["takvimde olmayan tarih", { from: "2026-02-31T00:00:00Z", to: "2026-03-01T00:00:00Z" }],
    ["eksik to", { from: "2026-11-15T12:00:00Z" }],
    ["bozuk metrik adi", { metric: "BOZUK AD", from: "2026-11-15T11:00:00Z", to: "2026-11-15T12:00:00Z" }],
    ["cok uzun metrik adi", { metric: "x".repeat(70) + ".y", from: "2026-11-15T11:00:00Z", to: "2026-11-15T12:00:00Z" }],
    ["max_points=1", { max_points: 1, from: "2026-11-15T11:00:00Z", to: "2026-11-15T12:00:00Z" }],
    ["max_points=5000", { max_points: 5000, from: "2026-11-15T11:00:00Z", to: "2026-11-15T12:00:00Z" }],
    ["max_points=abc", { max_points: "abc", from: "2026-11-15T11:00:00Z", to: "2026-11-15T12:00:00Z" }],
    ["bilinmeyen parametre", { foo: "bar", from: "2026-11-15T11:00:00Z", to: "2026-11-15T12:00:00Z" }],
  ])("%s -> 400", async (_n, q) => {
    const base: Record<string, string | number> = { metric: "cpu.total" };
    const r = await api(k, "GET", url(devA, { ...base, ...q }), { cookie });
    expect(r.statusCode).toBe(400);
  });

  it("BASKA org'un cihazi 404 (veri sizmaz); olmayan cihaz ile ayni gövde", async () => {
    const q = { metric: "cpu.total", from: iso(new Date(T.getTime() - HOUR)), to: iso(T) };
    const other = await api(k, "GET", url(devB, q), { cookie });
    const missing = await api(k, "GET", url("00000000-0000-4000-8000-000000000000", q), { cookie });
    expect(other.statusCode).toBe(404);
    expect(other.body).toBe(missing.body);
    expect(other.body).not.toContain("1234");
  });

  it("SQL enjeksiyonu: metrik adi regex'ten gecmez (400), parametreli sorgu", async () => {
    const r = await api(k, "GET", url(devA, { metric: "cpu.total'; DROP TABLE metric_samples;--", from: iso(new Date(T.getTime() - HOUR)), to: iso(T) }), { cookie });
    expect(r.statusCode).toBe(400);
    expect(Number((await k.db.pool.query("SELECT count(*) FROM metric_samples")).rows[0].count)).toBeGreaterThan(0);
  });
});

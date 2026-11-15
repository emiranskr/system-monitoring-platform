import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deviceStatus } from "../src/devices.js";
import { addUser, api, loginAs, setupKit, type Kit } from "./kit.js";

const PW = "yeterince-uzun-parola-1";
let k: Kit;
let orgB = "", devA1 = "", devA2 = "", devB = "", devNever = "", devRevoked = "";
let cookieA = "", cookieViewer = "";

beforeAll(async () => {
  k = await setupKit();
  const q = (sql: string, p: unknown[] = []) => k.db.pool.query(sql, p);
  orgB = (await q("INSERT INTO orgs (name) VALUES ('B') RETURNING id")).rows[0].id;
  const mk = async (org: string, name: string, lastSeen: Date | null, revoked = false) =>
    (await q("INSERT INTO devices (org_id, name, last_seen_at, revoked_at, device_info) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [org, name, lastSeen, revoked ? k.clock.now : null, JSON.stringify({ hostname: name, os: "Windows 11" })])).rows[0].id as string;
  const now = k.clock.now;
  devA1 = await mk(k.org, "pc-a1", new Date(now.getTime() - 5_000));
  devA2 = await mk(k.org, "pc-a2", new Date(now.getTime() - 10 * 60_000));
  devNever = await mk(k.org, "pc-never", null);
  devRevoked = await mk(k.org, "pc-revoked", new Date(now.getTime() - 5_000), true);
  devB = await mk(orgB, "pc-b", new Date(now.getTime() - 5_000));
  const put = (dev: string, org: string, metric: string, v: number, ageS = 3) =>
    q("INSERT INTO metric_samples (ts, org_id, device_id, metric, value) VALUES ($1,$2,$3,$4,$5)", [new Date(now.getTime() - ageS * 1000), org, dev, metric, v]);
  await put(devA1, k.org, "cpu.total", 12.5); await put(devA1, k.org, "cpu.total", 40, 20); // eski deger gozukmemeli
  await put(devA1, k.org, "mem.used_pct", 61);
  await put(devA1, k.org, "disk.c.used_pct", 55); await put(devA1, k.org, "disk.d.used_pct", 83);
  await put(devB, orgB, "cpu.total", 99);
  await addUser(k, "admin@example.com", PW, "admin");
  await addUser(k, "viewer@example.com", PW, "viewer");
  cookieA = await loginAs(k, "admin@example.com", PW);
  cookieViewer = await loginAs(k, "viewer@example.com", PW);
}, 120_000);
afterAll(async () => { await k?.close(); });

describe("deviceStatus", () => {
  const now = new Date("2026-11-15T12:00:00Z");
  const ago = (s: number) => new Date(now.getTime() - s * 1000);
  it.each([
    [5, 5, "online"], [30, 5, "online"], [31, 5, "stale"], [120, 5, "stale"], [121, 5, "offline"], [3600, 5, "offline"],
    [40, 10, "online"], [61, 10, "stale"], // 10 sn ornekleme: online siniri 6x = 60 sn
  ])("son gorulme %i sn once, aralik %i sn -> %s", (age, interval, want) => {
    expect(deviceStatus(ago(age), null, now, interval)).toBe(want);
  });
  it("hic gorulmemis -> unknown; iptal edilmis -> revoked (gorulme zamanindan bagimsiz)", () => {
    expect(deviceStatus(null, null, now, 5)).toBe("unknown");
    expect(deviceStatus(ago(1), now, now, 5)).toBe("revoked");
  });
  it("gelecek tarihli last_seen (saat sapmasi) online sayilir, cokmez", () => {
    expect(deviceStatus(new Date(now.getTime() + 60_000), null, now, 5)).toBe("online");
  });
});

describe("GET /api/v1/devices", () => {
  it("oturumsuz 401", async () => { expect((await api(k, "GET", "/api/v1/devices")).statusCode).toBe(401); });

  it("yalniz KENDI org'unun cihazlarini listeler; baska org'unkiler yok", async () => {
    const r = await api(k, "GET", "/api/v1/devices", { cookie: cookieA });
    expect(r.statusCode).toBe(200);
    const names = (r.json().devices as { name: string }[]).map((d) => d.name).sort();
    expect(names).toEqual(["pc-a1", "pc-a2", "pc-never", "pc-revoked"]);
    expect(r.body).not.toContain("pc-b");
    expect(r.body).not.toContain(devB);
  });

  it("son degerler: cpu/bellek/disk (en yuksek disk), eski ornek degil; durumlar dogru", async () => {
    const r = await api(k, "GET", "/api/v1/devices", { cookie: cookieA });
    const by = Object.fromEntries((r.json().devices as { name: string }[]).map((d) => [d.name, d])) as Record<string, any>;
    expect(by["pc-a1"]).toMatchObject({ id: devA1, status: "online", cpu_pct: 12.5, mem_pct: 61, disk_used_pct: 83 });
    expect(by["pc-a2"]).toMatchObject({ status: "offline", cpu_pct: null, mem_pct: null, disk_used_pct: null });
    expect(by["pc-never"]).toMatchObject({ status: "unknown", last_seen_at: null, cpu_pct: null });
    expect(by["pc-revoked"]).toMatchObject({ status: "revoked" });
  });

  it("viewer de okuyabilir", async () => {
    expect((await api(k, "GET", "/api/v1/devices", { cookie: cookieViewer })).statusCode).toBe(200);
  });

  it("sorgu sayisi cihaz sayisindan BAGIMSIZ (N+1 yok)", async () => {
    const orig = k.db.pool.query.bind(k.db.pool);
    let n = 0;
    (k.db.pool as any).query = (...a: unknown[]) => { n++; return (orig as any)(...a); };
    try {
      const count = async () => { n = 0; await api(k, "GET", "/api/v1/devices", { cookie: cookieA }); return n; };
      const before = await count();
      for (let i = 0; i < 30; i++) await k.db.pool.query("INSERT INTO devices (org_id, name) VALUES ($1,$2)", [k.org, `bulk-${i}`]);
      const after = await count();
      expect(after).toBe(before);
      expect(after).toBeLessThanOrEqual(3); // oturum cozumu + liste
    } finally { (k.db.pool as any).query = orig; }
  });
});

describe("GET /api/v1/devices/:id", () => {
  it("kendi cihazi: ayrintilar ve device_info", async () => {
    const r = await api(k, "GET", `/api/v1/devices/${devA1}`, { cookie: cookieA });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: devA1, name: "pc-a1", status: "online", device_info: { hostname: "pc-a1", os: "Windows 11" } });
  });

  it("BASKA org'un cihazi 404; olmayan id ile AYNI durum ve govde (varlik sizmaz)", async () => {
    const other = await api(k, "GET", `/api/v1/devices/${devB}`, { cookie: cookieA });
    const missing = await api(k, "GET", "/api/v1/devices/00000000-0000-4000-8000-000000000000", { cookie: cookieA });
    expect(other.statusCode).toBe(404);
    expect(other.statusCode).toBe(missing.statusCode);
    expect(other.body).toBe(missing.body);
    expect(other.body).not.toContain("pc-b");
  });

  it("uuid olmayan :id 400 degil 404 (bicim bilgisi sizmaz)", async () => {
    for (const bad of ["abc", "1", "'; DROP TABLE devices;--", "%00"]) {
      expect((await api(k, "GET", `/api/v1/devices/${encodeURIComponent(bad)}`, { cookie: cookieA })).statusCode, bad).toBe(404);
    }
  });
});

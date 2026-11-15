import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@sysmon/db/testing";
import { DEFAULT_SESSION_CONFIG, createSession, resolveSession, revokeAllForUser, revokeSession, type SessionConfig } from "../src/sessions.js";

let db: TestDb;
let org = "", user = "", other = "";
const T0 = new Date("2026-11-15T12:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60_000, HOUR = 3600_000;
const cfg: SessionConfig = DEFAULT_SESSION_CONFIG;

beforeAll(async () => {
  db = await createTestDb();
  org = (await db.pool.query("INSERT INTO orgs (name) VALUES ('o') RETURNING id")).rows[0].id;
  user = (await db.pool.query("INSERT INTO users (org_id, email, password_hash, role) VALUES ($1,'a@x.y','h','admin') RETURNING id", [org])).rows[0].id;
  other = (await db.pool.query("INSERT INTO users (org_id, email, password_hash, role) VALUES ($1,'b@x.y','h','viewer') RETURNING id", [org])).rows[0].id;
}, 120_000);
afterAll(async () => { await db?.drop(); });
beforeEach(async () => { await db.pool.query("DELETE FROM sessions"); await db.pool.query("UPDATE users SET disabled_at=NULL"); });

const make = (u = user, now = T0) => createSession(db.pool, { id: u, orgId: org }, now, cfg, { ip: "203.0.113.5", ua: "test" });

describe("oturumlar", () => {
  it("varsayilanlar: 30 dk bosta, 12 sa mutlak", () => {
    expect(cfg).toEqual({ idleMs: 30 * MIN, absoluteMs: 12 * HOUR });
  });

  it("gecerli oturum cozulur ve kullanici bilgisini verir", async () => {
    const s = await make();
    const r = await resolveSession(db.pool, s.id, at(MIN), cfg);
    expect(r).toMatchObject({ userId: user, orgId: org, role: "admin", email: "a@x.y" });
    expect(s.expiresAt.getTime()).toBe(T0.getTime() + 12 * HOUR);
  });

  it("DB'de ham kimlik YOK: yalniz 32 baytlik ozet", async () => {
    const s = await make();
    const rows = (await db.pool.query("SELECT id_hash FROM sessions")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].id_hash).toHaveLength(32);
    expect(rows[0].id_hash.toString("utf8")).not.toContain(s.id);
    expect(s.id.length).toBeGreaterThanOrEqual(43); // 256 bit base64url
  });

  it("bilinmeyen/bos/cok uzun kimlik null (istisna yok)", async () => {
    for (const bad of ["", "yok", "x".repeat(5000)]) expect(await resolveSession(db.pool, bad, T0, cfg)).toBeNull();
  });

  it("31. dakikada bosta asimi: null ve satir silinir", async () => {
    const s = await make();
    expect(await resolveSession(db.pool, s.id, at(31 * MIN), cfg)).toBeNull();
    expect(Number((await db.pool.query("SELECT count(*) FROM sessions")).rows[0].count)).toBe(0);
  });

  it("surekli aktif olsa bile 12 sa + 1 dk sonra MUTLAK asim", async () => {
    const s = await make();
    for (let m = 20; m < 12 * 60; m += 20) expect(await resolveSession(db.pool, s.id, at(m * MIN), cfg)).not.toBeNull(); // 11 sa 40 dk'ya kadar
    expect(await resolveSession(db.pool, s.id, at(12 * HOUR), cfg)).toBeNull(); // tam 12. sa: sinir DAHIL asim (>=)
  });

  it("etkinlik bosta sayacini yeniler (29 dk arayla kullanilirsa yasar)", async () => {
    const s = await make();
    expect(await resolveSession(db.pool, s.id, at(29 * MIN), cfg)).not.toBeNull();
    expect(await resolveSession(db.pool, s.id, at(58 * MIN), cfg)).not.toBeNull();
  });

  it("last_seen_at 30 sn icinde ikinci cozumde yeniden YAZILMAZ", async () => {
    const s = await make();
    await resolveSession(db.pool, s.id, at(5_000), cfg);
    const a = (await db.pool.query("SELECT last_seen_at FROM sessions")).rows[0].last_seen_at as Date;
    await resolveSession(db.pool, s.id, at(20_000), cfg);
    const b = (await db.pool.query("SELECT last_seen_at FROM sessions")).rows[0].last_seen_at as Date;
    expect(b.getTime()).toBe(a.getTime());
    await resolveSession(db.pool, s.id, at(70_000), cfg);
    const c = (await db.pool.query("SELECT last_seen_at FROM sessions")).rows[0].last_seen_at as Date;
    expect(c.getTime()).toBe(at(70_000).getTime());
  });

  it("touch:false (SSE yeniden dogrulamasi) oturumu CANLI TUTMAZ: bosta sayaci yenilenmez, 31. dk'da yine asilir", async () => {
    const s = await make();
    for (let m = 5; m <= 25; m += 5) expect(await resolveSession(db.pool, s.id, at(m * MIN), cfg, { touch: false })).not.toBeNull();
    const seen = (await db.pool.query("SELECT last_seen_at FROM sessions")).rows[0].last_seen_at as Date;
    expect(seen.getTime()).toBe(T0.getTime());
    expect(await resolveSession(db.pool, s.id, at(31 * MIN), cfg, { touch: false })).toBeNull();
  });

  it("revokeSession sonrasi null", async () => {
    const s = await make();
    await revokeSession(db.pool, s.id);
    expect(await resolveSession(db.pool, s.id, at(MIN), cfg)).toBeNull();
  });

  it("revokeAllForUser yalniz o kullanicinin TUM oturumlarini siler", async () => {
    const a1 = await make(), a2 = await make(), b = await make(other);
    expect(await revokeAllForUser(db.pool, user)).toBe(2);
    expect(await resolveSession(db.pool, a1.id, at(MIN), cfg)).toBeNull();
    expect(await resolveSession(db.pool, a2.id, at(MIN), cfg)).toBeNull();
    expect(await resolveSession(db.pool, b.id, at(MIN), cfg)).not.toBeNull();
  });

  it("devre disi birakilan kullanicinin oturumu null", async () => {
    const s = await make();
    await db.pool.query("UPDATE users SET disabled_at=$1 WHERE id=$2", [T0, user]);
    expect(await resolveSession(db.pool, s.id, at(MIN), cfg)).toBeNull();
  });

  it("her oturum benzersiz kimlik alir", async () => {
    const ids = new Set((await Promise.all(Array.from({ length: 20 }, () => make()))).map((s) => s.id));
    expect(ids.size).toBe(20);
  });
});

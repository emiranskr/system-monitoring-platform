import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUser, api, deviceInfo, loginAs, post, setupKit, type Kit } from "./kit.js";

const PW = "yeterince-uzun-parola-1";
let k: Kit;
let admin = "", owner = "", viewer = "";
beforeAll(async () => {
  k = await setupKit();
  await addUser(k, "admin@example.com", PW, "admin");
  await addUser(k, "owner@example.com", PW, "owner");
  await addUser(k, "viewer@example.com", PW, "viewer");
  admin = await loginAs(k, "admin@example.com", PW);
  owner = await loginAs(k, "owner@example.com", PW);
  viewer = await loginAs(k, "viewer@example.com", PW);
}, 120_000);
afterAll(async () => { await k?.close(); });

const create = (cookie?: string, body: unknown = {}, origin?: string | null) => api(k, "POST", "/api/v1/enrollment-tokens", { body, cookie, origin });

describe("POST /api/v1/enrollment-tokens", () => {
  it("oturumsuz 401; Origin yok 403; viewer 403", async () => {
    expect((await create()).statusCode).toBe(401);
    expect((await create(admin, {}, null)).statusCode).toBe(403);
    expect((await create(viewer)).statusCode).toBe(403);
  });

  it("admin ve owner token uretir: 201, varsayilan 60 dk gecerlilik, token yalniz bu yanitta", async () => {
    for (const c of [admin, owner]) {
      const r = await create(c);
      expect(r.statusCode).toBe(201);
      const j = r.json();
      expect(typeof j.token).toBe("string");
      expect(j.token.length).toBeGreaterThanOrEqual(43);
      expect(new Date(j.expires_at).getTime()).toBe(k.clock.now.getTime() + 60 * 60_000);
    }
  });

  it("ttl_minutes: 5..1440 kabul, disi 400; bilinmeyen alan 400", async () => {
    expect((await create(admin, { ttl_minutes: 5 })).statusCode).toBe(201);
    expect((await create(admin, { ttl_minutes: 1440 })).statusCode).toBe(201);
    for (const bad of [4, 1441, 0, -1, 1.5, "60"]) expect((await create(admin, { ttl_minutes: bad })).statusCode, String(bad)).toBe(400);
    expect((await create(admin, { org_id: "x" })).statusCode).toBe(400);
  });

  it("uretilen token UCTAN UCA kullanilir: cihaz KENDI org'unda olusur; token tek kullanimlik", async () => {
    const t = (await create(admin, { ttl_minutes: 30 })).json().token as string;
    const body = { token: t, enroll_id: "e0000000-0000-4000-8000-000000000001", machine_guid: "g-e2e", device_info: deviceInfo };
    const r = await post(k, "/agent/v1/enroll", body);
    expect(r.statusCode).toBe(200);
    const dev = (await k.db.pool.query("SELECT org_id FROM devices WHERE id=$1", [r.json().device_id])).rows[0];
    expect(dev.org_id).toBe(k.org);
    expect((await post(k, "/agent/v1/enroll", { ...body, enroll_id: "e0000000-0000-4000-8000-000000000002" })).statusCode).toBe(401);
  });

  it("DB'de yalniz ozet (ham token yok); audit olayi yazilir ve token icermez", async () => {
    const t = (await create(admin)).json().token as string;
    const rows = (await k.db.pool.query("SELECT token_hash FROM enrollment_tokens")).rows;
    for (const r of rows) expect(r.token_hash.toString("utf8")).not.toContain(t);
    const audit = (await k.db.pool.query("SELECT detail::text d, org_id FROM audit_events WHERE kind='enrollment_token_created'")).rows;
    expect(audit.length).toBeGreaterThan(0);
    for (const a of audit) { expect(a.d).not.toContain(t); expect(a.org_id).toBe(k.org); }
  });

  it("kullanici basina hiz siniri: 11. istek 429", async () => {
    const kk = await setupKit({ limits: { enrollTokenPerUser: 10, loginPerKey: 1000, loginPerIp: 1000, ingestPerDevice: 100_000, failedAuthPerIp: 100_000, enrollPerIp: 100_000, rotatePerDevice: 100_000 } });
    try {
      await addUser(kk, "a@example.com", PW, "admin");
      const c = await loginAs(kk, "a@example.com", PW);
      const rs = [];
      for (let i = 0; i < 11; i++) rs.push((await api(kk, "POST", "/api/v1/enrollment-tokens", { body: {}, cookie: c })).statusCode);
      expect(rs.slice(0, 10)).toEqual(Array(10).fill(201));
      expect(rs[10]).toBe(429);
    } finally { await kk.close(); }
  });
});

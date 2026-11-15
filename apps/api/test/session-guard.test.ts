import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestDb, type TestDb } from "@sysmon/db/testing";
import { buildApp } from "../src/app.js";
import { COOKIE_NAME, PUBLIC_API_PATHS, parseCookies, requireRole, sessionCookie, clearSessionCookie } from "../src/session-guard.js";
import { DEFAULT_SESSION_CONFIG, createSession } from "../src/sessions.js";

const ORIGIN = "https://panel.example.test";
const T0 = new Date("2026-11-15T12:00:00Z");
let db: TestDb, app: FastifyInstance;
let org = "", admin = "", viewer = "";
let adminSid = "", viewerSid = "";

beforeAll(async () => {
  db = await createTestDb();
  app = buildApp({ pool: db.pool, credentialKey: Buffer.alloc(32, 1), now: () => T0, auth: { allowedOrigins: [ORIGIN] } });
  // Test sondalari: guvenli GET, durum degistiren POST, yonetici-gerektiren POST, genel (oturumsuz) yol.
  app.get("/api/v1/_probe", async (req) => ({ email: req.session?.email }));
  app.post("/api/v1/_probe", async () => ({ ok: true }));
  app.post("/api/v1/_admin", { preHandler: requireRole("admin", "owner") }, async () => ({ ok: true }));
  app.get("/api/v1/login", async () => ({ public: true }));
  await app.ready();
  org = (await db.pool.query("INSERT INTO orgs (name) VALUES ('o') RETURNING id")).rows[0].id;
  admin = (await db.pool.query("INSERT INTO users (org_id, email, password_hash, role) VALUES ($1,'a@x.y','h','admin') RETURNING id", [org])).rows[0].id;
  viewer = (await db.pool.query("INSERT INTO users (org_id, email, password_hash, role) VALUES ($1,'v@x.y','h','viewer') RETURNING id", [org])).rows[0].id;
  adminSid = (await createSession(db.pool, { id: admin, orgId: org }, T0, DEFAULT_SESSION_CONFIG, {})).id;
  viewerSid = (await createSession(db.pool, { id: viewer, orgId: org }, T0, DEFAULT_SESSION_CONFIG, {})).id;
}, 120_000);
afterAll(async () => { await app?.close(); await db?.drop(); });

const cookie = (sid: string) => ({ cookie: `${COOKIE_NAME}=${sid}` });

describe("oturum kapisi", () => {
  it("cerezsiz istek 401", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/_probe" })).statusCode).toBe(401);
  });

  it("bozuk, bilinmeyen veya baska adli cerez 401", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/_probe", headers: cookie("yok-boyle-bir-oturum") })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/v1/_probe", headers: { cookie: `sid=${adminSid}` } })).statusCode).toBe(401);
  });

  it("gecerli oturum: 200 ve req.session dolu", async () => {
    const r = await app.inject({ method: "GET", url: "/api/v1/_probe", headers: cookie(adminSid) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ email: "a@x.y" });
  });

  it("genel yollar (login, setup) oturum istemez; allowlist tam olarak bu ikisi", async () => {
    expect([...PUBLIC_API_PATHS].sort()).toEqual(["/api/v1/login", "/api/v1/setup"]);
    expect((await app.inject({ method: "GET", url: "/api/v1/login" })).statusCode).toBe(200);
  });

  it("sorgu dizesi/buyuk kucuk harf ile genel yol atlatilamaz", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/_probe?x=/api/v1/login" })).statusCode).toBe(401);
    // Genel yol gibi GORUNUP korumali rotaya dusen yollar da 401 almali (kapi ile yonlendirici ayni yolu gormeli).
    for (const u of ["/api/v1/login/../_probe", "/api/v1/login/%2e%2e/_probe"]) {
      const r = await app.inject({ method: "GET", url: u });
      expect([401, 404], u).toContain(r.statusCode);
      expect(r.statusCode === 200, u).toBe(false);
    }
  });

  it("agent yollari (/agent/v1/*) bu kapidan etkilenmez: Origin istenmez, oturum istenmez", async () => {
    const r = await app.inject({ method: "POST", url: "/agent/v1/ingest", headers: { "content-type": "application/json" }, payload: "{}" });
    expect(r.statusCode).toBe(401); // agent kimlik dogrulamasi (bearer), 403 origin DEGIL
    expect(r.json().error).toBe("unauthorized");
  });
});

describe("CSRF: Origin denetimi", () => {
  const post = (headers: Record<string, string>) => app.inject({ method: "POST", url: "/api/v1/_probe", headers: { "content-type": "application/json", ...headers }, payload: "{}" });

  it("POST: Origin yok -> 403 (gecerli oturum olsa bile)", async () => {
    expect((await post(cookie(adminSid))).statusCode).toBe(403);
  });

  it("POST: yabanci Origin -> 403", async () => {
    expect((await post({ ...cookie(adminSid), origin: "https://kotu.example" })).statusCode).toBe(403);
    expect((await post({ ...cookie(adminSid), origin: ORIGIN + ".kotu.example" })).statusCode).toBe(403);
    expect((await post({ ...cookie(adminSid), origin: "null" })).statusCode).toBe(403);
  });

  it("POST: izinli Origin + gecerli oturum -> 200", async () => {
    expect((await post({ ...cookie(adminSid), origin: ORIGIN })).statusCode).toBe(200);
  });

  it("POST: izinli Origin ama oturum yok -> 401 (Origin tek basina yetki vermez)", async () => {
    expect((await post({ origin: ORIGIN })).statusCode).toBe(401);
  });

  it("GET Origin gerektirmez", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/_probe", headers: cookie(adminSid) })).statusCode).toBe(200);
  });

  it("izinli kokenler bos ise (varsayilan) durum degistiren istek REDDEDILIR", async () => {
    const closed = buildApp({ pool: db.pool, credentialKey: Buffer.alloc(32, 1), now: () => T0 });
    closed.post("/api/v1/_probe", async () => ({ ok: true }));
    await closed.ready();
    try {
      const r = await closed.inject({ method: "POST", url: "/api/v1/_probe", headers: { ...cookie(adminSid), origin: ORIGIN, "content-type": "application/json" }, payload: "{}" });
      expect(r.statusCode).toBe(403);
    } finally { await closed.close(); }
  });
});

describe("roller", () => {
  const adminPost = (sid: string) => app.inject({ method: "POST", url: "/api/v1/_admin", headers: { ...cookie(sid), origin: ORIGIN, "content-type": "application/json" }, payload: "{}" });
  it("viewer yonetici ucunda 403, admin 200", async () => {
    expect((await adminPost(viewerSid)).statusCode).toBe(403);
    expect((await adminPost(adminSid)).statusCode).toBe(200);
  });
});

describe("cerez bicimi ve ayristirma", () => {
  it("oturum cerezi: __Host- oneki, HttpOnly, Secure, SameSite=Lax, Path=/, Domain YOK", () => {
    const c = sessionCookie("abc", 3600);
    expect(c.startsWith("__Host-sid=abc")).toBe(true);
    for (const part of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=3600"]) expect(c).toContain(part);
    expect(c).not.toMatch(/Domain=/i);
  });
  it("temizleme cereri Max-Age=0 ve ayni oznitelikler", () => {
    const c = clearSessionCookie();
    expect(c).toContain("Max-Age=0");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Path=/");
  });
  it("parseCookies: coklu cerez, bosluk, = iceren deger, bozuk girdi", () => {
    expect(parseCookies("a=1; b=2;c=x=y")).toEqual({ a: "1", b: "2", c: "x=y" });
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies("bozuk; =x; ")).toEqual({});
  });
});

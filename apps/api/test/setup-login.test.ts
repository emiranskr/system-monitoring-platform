import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureSetupToken } from "../src/users.js";
import { COOKIE_NAME } from "../src/session-guard.js";
import { addUser, api, cookieFrom, loginAs, setupKit, type Kit } from "./kit.js";

const PW = "yeterince-uzun-parola-1";
let k: Kit;
beforeAll(async () => { k = await setupKit(); }, 120_000);
afterAll(async () => { await k?.close(); });

/** ensureSetupToken'in ciktisini yakalar; mesajin son sozcugu token'dir. */
async function newSetupToken(): Promise<{ token: string; writes: string[] }> {
  const writes: string[] = [];
  expect(await ensureSetupToken(k.db.pool, k.clock.now, (m) => writes.push(m))).toBe(true);
  return { token: writes[0]!.trim().split(/\s+/).pop()!, writes };
}
const setup = (body: unknown) => api(k, "POST", "/api/v1/setup", { body });
const usersCount = async () => Number((await k.db.pool.query("SELECT count(*) FROM users")).rows[0].count);

describe("ilk kurulum (setup token)", () => {
  it("users bos iken token uretilir, BIR kez yazilir, DB'de duz degil; ikinci cagri eskisini gecersiz kilar", async () => {
    const a = await newSetupToken();
    expect(a.writes).toHaveLength(1);
    expect(a.token.length).toBeGreaterThanOrEqual(43);
    const rows = (await k.db.pool.query("SELECT token_hash FROM setup_tokens")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash.toString("utf8")).not.toContain(a.token);
    const b = await newSetupToken();
    expect(b.token).not.toBe(a.token);
    expect((await setup({ token: a.token, email: "owner@example.com", password: PW })).statusCode).toBe(401); // eski token artik gecersiz
    expect(await usersCount()).toBe(0);
  });

  it("yanlis token 401, zayif parola 400, bilinmeyen alan 400; hicbiri kullanici olusturmaz", async () => {
    const { token } = await newSetupToken();
    expect((await setup({ token: "yanlis".repeat(8), email: "owner@example.com", password: PW })).statusCode).toBe(401);
    expect((await setup({ token, email: "owner@example.com", password: "kisa" })).statusCode).toBe(400);
    expect((await setup({ token, email: "gecersiz-eposta", password: PW })).statusCode).toBe(400);
    expect((await setup({ token, email: "owner@example.com", password: PW, role: "owner" })).statusCode).toBe(400);
    expect(await usersCount()).toBe(0);
  });

  it("basari: owner olusur, oturum acilmaz, parola duz saklanmaz; token tuketilir; uc nokta kalici kapanir", async () => {
    const { token } = await newSetupToken();
    const r = await setup({ token, email: "Owner@Example.com", password: PW });
    expect(r.statusCode).toBe(201);
    const u = (await k.db.pool.query("SELECT email, role, password_hash, org_id FROM users")).rows;
    expect(u).toHaveLength(1);
    expect(u[0]).toMatchObject({ email: "Owner@Example.com", role: "owner", org_id: k.org });
    expect(u[0].password_hash).toMatch(/^\$argon2id\$/);
    expect(u[0].password_hash).not.toContain(PW);
    expect(cookieFrom(r)).toBeNull();
    expect((await setup({ token, email: "baska2@example.com", password: PW })).statusCode).toBe(404); // users dolu: kapali
    expect(await usersCount()).toBe(1);
    expect((await k.db.pool.query("SELECT kind FROM audit_events WHERE kind='owner_created'")).rowCount).toBe(1);
  });

  it("users doluyken ensureSetupToken false doner ve yazmaz", async () => {
    const writes: string[] = [];
    expect(await ensureSetupToken(k.db.pool, k.clock.now, (m) => writes.push(m))).toBe(false);
    expect(writes).toHaveLength(0);
  });
});

describe("ilk kurulum: eszamanlilik", () => {
  it("6 es zamanli setup ayni token ile: TAM 1 basari, tek owner", async () => {
    await k.db.pool.query("DELETE FROM users");
    const { token } = await newSetupToken();
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => setup({ token, email: `o${i}@example.com`, password: PW })));
    expect(rs.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.statusCode !== 201 && r.statusCode !== 401 && r.statusCode !== 404).map((r) => r.statusCode)).toEqual([]);
    expect(await usersCount()).toBe(1);
  });
});

describe("giris, cikis, me", () => {
  let cookie = "";
  beforeAll(async () => {
    await k.db.pool.query("DELETE FROM users");
    await addUser(k, "ali@example.com", PW, "admin");
    await addUser(k, "pasif@example.com", PW, "viewer");
    await k.db.pool.query("UPDATE users SET disabled_at=now() WHERE email='pasif@example.com'");
  });

  it("dogru giris: 200, cerez bayraklari, /me calisir (e-posta buyuk/kucuk harf duyarsiz)", async () => {
    const r = await api(k, "POST", "/api/v1/login", { body: { email: "ALI@Example.com", password: PW } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ user: { email: "ali@example.com", role: "admin" } });
    const raw = String(r.headers["set-cookie"]);
    for (const p of [`${COOKIE_NAME}=`, "HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) expect(raw).toContain(p);
    cookie = cookieFrom(r)!;
    const me = await api(k, "GET", "/api/v1/me", { cookie });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ email: "ali@example.com", role: "admin" });
  });

  it("yanlis parola, olmayan e-posta ve devre disi kullanici: AYNI durum ve AYNI govde", async () => {
    const bodies = await Promise.all([
      api(k, "POST", "/api/v1/login", { body: { email: "ali@example.com", password: "yanlis-parola-123" } }),
      api(k, "POST", "/api/v1/login", { body: { email: "yok@example.com", password: PW } }),
      api(k, "POST", "/api/v1/login", { body: { email: "pasif@example.com", password: PW } }),
    ]);
    for (const r of bodies) { expect(r.statusCode).toBe(401); expect(r.json()).toEqual({ error: "invalid_credentials" }); expect(cookieFrom(r)).toBeNull(); }
  });

  it("zamanlama: olmayan e-posta yolu gercek dogrulamayla ayni buyuklukte (kullanici sayimi yok)", async () => {
    const t = async (email: string) => { const s = performance.now(); await api(k, "POST", "/api/v1/login", { body: { email, password: "yanlis-parola-123" } }); return performance.now() - s; };
    await t("ali@example.com"); await t("yok@example.com"); // isitma
    const real: number[] = [], none: number[] = [];
    for (let i = 0; i < 5; i++) { real.push(await t("ali@example.com")); none.push(await t("yok@example.com")); }
    const med = (a: number[]) => [...a].sort((x, y) => x - y)[2]!;
    const ratio = med(none) / med(real);
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);
  });

  it("girisde oturum kimligi yenilenir: eski cerez gecersiz olur", async () => {
    const first = await loginAs(k, "ali@example.com", PW);
    const r = await api(k, "POST", "/api/v1/login", { body: { email: "ali@example.com", password: PW }, cookie: first });
    const second = cookieFrom(r)!;
    expect(second).not.toBe(first);
    expect((await api(k, "GET", "/api/v1/me", { cookie: first })).statusCode).toBe(401);
    expect((await api(k, "GET", "/api/v1/me", { cookie: second })).statusCode).toBe(200);
  });

  it("login govdesi: bilinmeyen alan veya eksik alan 400", async () => {
    expect((await api(k, "POST", "/api/v1/login", { body: { email: "ali@example.com" } })).statusCode).toBe(400);
    expect((await api(k, "POST", "/api/v1/login", { body: { email: "ali@example.com", password: PW, x: 1 } })).statusCode).toBe(400);
  });

  it("login CSRF: Origin yok veya yabanci -> 403 (cerez verilmez)", async () => {
    const r = await api(k, "POST", "/api/v1/login", { body: { email: "ali@example.com", password: PW }, origin: "https://kotu.example" });
    expect(r.statusCode).toBe(403);
    expect(cookieFrom(r)).toBeNull();
    expect((await api(k, "POST", "/api/v1/login", { body: { email: "ali@example.com", password: PW }, origin: null })).statusCode).toBe(403);
  });

  it("cikis: oturum silinir, cerez temizlenir, ardindan /me 401", async () => {
    const c = await loginAs(k, "ali@example.com", PW);
    const out = await api(k, "POST", "/api/v1/logout", { cookie: c });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers["set-cookie"])).toContain("Max-Age=0");
    expect((await api(k, "GET", "/api/v1/me", { cookie: c })).statusCode).toBe(401);
  });

  it("audit: giris/cikis/basarisiz kayitlari yazilir; parola ve e-posta icermez", async () => {
    const rows = (await k.db.pool.query("SELECT kind, detail::text AS d FROM audit_events WHERE kind IN ('login_ok','login_failed','logout')")).rows;
    expect(new Set(rows.map((r) => r.kind))).toEqual(new Set(["login_ok", "login_failed", "logout"]));
    for (const r of rows) { expect(r.d).not.toContain(PW); expect(r.d).not.toContain("example.com"); }
  });
});

describe("giris: IP metni", () => {
  it("bolge kimlikli link-local IPv6 istemciyle giris 500 vermez (M-1)", async () => {
    await addUser(k, "zone@example.com", PW, "viewer");
    const r = await k.app.inject({ method: "POST", url: "/api/v1/login", remoteAddress: "fe80::1%eth0",
      headers: { "content-type": "application/json", origin: "https://panel.example.test" }, payload: JSON.stringify({ email: "zone@example.com", password: PW }) });
    expect(r.statusCode).toBe(200);
  });
});

describe("giris hiz siniri", () => {
  it("IP basina toplam sinir (loginPerIp): farkli e-postalarla puskurtme 4. denemede 429 (M-2: mutasyon kilidi)", async () => {
    const kk = await setupKit({ limits: { loginPerIp: 3, loginPerKey: 1000, enrollPerIp: 100_000, ingestPerDevice: 100_000, failedAuthPerIp: 100_000, rotatePerDevice: 100_000 } });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) codes.push((await api(kk, "POST", "/api/v1/login", { body: { email: `kisi${i}@example.com`, password: "yanlis-parola-123" } })).statusCode);
      expect(codes).toEqual([401, 401, 401, 429]);
    } finally { await kk.close(); }
  });

  it("ayni IP+e-posta icin 4. hizli deneme 429 (Retry-After ile); baska e-posta etkilenmez", async () => {
    const kk = await setupKit({ limits: { loginPerKey: 3, loginPerIp: 1000, enrollPerIp: 100_000, ingestPerDevice: 100_000, failedAuthPerIp: 100_000, rotatePerDevice: 100_000 } });
    try {
      await addUser(kk, "ali@example.com", PW, "admin");
      const bad = () => api(kk, "POST", "/api/v1/login", { body: { email: "ali@example.com", password: "yanlis-parola-123" } });
      expect([(await bad()).statusCode, (await bad()).statusCode, (await bad()).statusCode]).toEqual([401, 401, 401]);
      const limited = await bad();
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBeDefined();
      // Sinirdayken DOGRU parola da denenmez (kaba kuvvet): ayni anahtar
      expect((await api(kk, "POST", "/api/v1/login", { body: { email: "ali@example.com", password: PW } })).statusCode).toBe(429);
      expect((await api(kk, "POST", "/api/v1/login", { body: { email: "baska@example.com", password: "yanlis-parola-123" } })).statusCode).toBe(401);
    } finally { await kk.close(); }
  });
});

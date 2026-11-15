import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_API_PATHS } from "../src/session-guard.js";
import { addUser, api, loginAs, setupKit, type Kit } from "./kit.js";

/**
 * IDOR / org izolasyonu paketi (proposal §10.5, M3 kabul): A org'unun kullanicisi B org'unun cihaz, metrik, akis ve
 * enrollment kaynaklarina erisemez; yanit varligi sizdirmaz. Ayrica TUM /api/v1 rotalari otomatik taranir.
 */
const PW = "yeterince-uzun-parola-1";
const UNKNOWN = "00000000-0000-4000-8000-000000000000";
let k: Kit;
let orgB = "", devA = "", devB = "";
let cookieA = "", cookieB = "";

beforeAll(async () => {
  k = await setupKit();
  const q = (sql: string, p: unknown[] = []) => k.db.pool.query(sql, p);
  orgB = (await q("INSERT INTO orgs (name) VALUES ('B-GIZLI-ORG') RETURNING id")).rows[0].id;
  devA = (await q("INSERT INTO devices (org_id, name, last_seen_at) VALUES ($1,'a-pc',$2) RETURNING id", [k.org, k.clock.now])).rows[0].id;
  devB = (await q("INSERT INTO devices (org_id, name, last_seen_at, device_info) VALUES ($1,'B-GIZLI-PC',$2,$3) RETURNING id", [orgB, k.clock.now, JSON.stringify({ hostname: "B-GIZLI-PC" })])).rows[0].id;
  await q("INSERT INTO metric_samples (ts, org_id, device_id, metric, value) VALUES ($1,$2,$3,'cpu.total',4242)", [new Date(k.clock.now.getTime() - 5_000), orgB, devB]);
  await addUser(k, "a@example.com", PW, "owner");
  await addUser(k, "b@example.com", PW, "owner", orgB);
  cookieA = await loginAs(k, "a@example.com", PW);
  cookieB = await loginAs(k, "b@example.com", PW);
}, 120_000);
afterAll(async () => { await k?.close(); });

const range = () => `from=${new Date(k.clock.now.getTime() - 3600_000).toISOString()}&to=${k.clock.now.toISOString()}`;

describe("A kullanicisi B kaynaklarina erisemez", () => {
  it("cihaz detayi: B'nin cihazi ile olmayan cihaz AYNI durum ve govde; B'ye dair hicbir alan yok", async () => {
    const other = await api(k, "GET", `/api/v1/devices/${devB}`, { cookie: cookieA });
    const missing = await api(k, "GET", `/api/v1/devices/${UNKNOWN}`, { cookie: cookieA });
    expect(other.statusCode).toBe(404);
    expect({ s: other.statusCode, b: other.body }).toEqual({ s: missing.statusCode, b: missing.body });
    for (const secret of ["B-GIZLI", devB, orgB]) expect(other.body).not.toContain(secret);
  });

  it("metrik sorgusu: B'nin cihazi 404, B'nin degeri (4242) hicbir yanitta yok", async () => {
    const other = await api(k, "GET", `/api/v1/devices/${devB}/metrics?metric=cpu.total&${range()}`, { cookie: cookieA });
    const missing = await api(k, "GET", `/api/v1/devices/${UNKNOWN}/metrics?metric=cpu.total&${range()}`, { cookie: cookieA });
    expect(other.statusCode).toBe(404);
    expect(other.body).toBe(missing.body);
    expect(other.body).not.toContain("4242");
  });

  it("filo listesi: B'nin cihazi ve org'u yok", async () => {
    const r = await api(k, "GET", "/api/v1/devices", { cookie: cookieA });
    expect(r.statusCode).toBe(200);
    for (const secret of ["B-GIZLI", devB, orgB, "4242"]) expect(r.body).not.toContain(secret);
    expect((r.json().devices as { id: string }[]).map((d) => d.id)).toEqual([devA]);
  });

  it("SSE: B'nin cihazini filtreleyerek akis acmak 404 (akis hic acilmaz)", async () => {
    const r = await api(k, "GET", `/api/v1/stream?devices=${devB}`, { cookie: cookieA });
    expect(r.statusCode).toBe(404);
    const miss = await api(k, "GET", `/api/v1/stream?devices=${UNKNOWN}`, { cookie: cookieA });
    expect(r.body).toBe(miss.body);
  });

  it("enrollment token: A'nin uretimi A org'una baglanir; B org'una cihaz eklenemez", async () => {
    const r = await api(k, "POST", "/api/v1/enrollment-tokens", { body: { org_id: orgB }, cookie: cookieA });
    expect(r.statusCode).toBe(400); // org_id alani kabul edilmez
    const ok = await api(k, "POST", "/api/v1/enrollment-tokens", { body: {}, cookie: cookieA });
    expect(ok.statusCode).toBe(201);
    const rows = (await k.db.pool.query("SELECT org_id FROM enrollment_tokens ORDER BY created_at DESC LIMIT 1")).rows;
    expect(rows[0].org_id).toBe(k.org);
  });

  it("simetri: B kullanicisi A'nin cihazini goremez", async () => {
    expect((await api(k, "GET", `/api/v1/devices/${devA}`, { cookie: cookieB })).statusCode).toBe(404);
    const list = await api(k, "GET", "/api/v1/devices", { cookie: cookieB });
    expect((list.json().devices as { id: string }[]).map((d) => d.id)).toEqual([devB]);
  });
});

/** Her /api/v1 rotasi ya org-verisi tasir (IDOR testlerinde kapsanmali) ya da org-notr olarak bilincli siniflandirilmali. */
const IDOR_COVERED = new Set([
  "GET /api/v1/devices", "GET /api/v1/devices/:id", "GET /api/v1/devices/:id/metrics", "GET /api/v1/stream", "POST /api/v1/enrollment-tokens",
]);
const ORG_NEUTRAL = new Set(["POST /api/v1/setup", "POST /api/v1/login", "POST /api/v1/logout", "GET /api/v1/me"]);

describe("rota kapsam denetimi (yeni rota unutulamaz)", () => {
  const apiRoutes = () => k.app.registeredRoutes.filter((r) => r.split(" ")[1]!.startsWith("/api/v1/"));

  it("her /api/v1 rotasi IDOR-kapsamli veya org-notr olarak siniflandirilmis", () => {
    const unknown = apiRoutes().filter((r) => !IDOR_COVERED.has(r) && !ORG_NEUTRAL.has(r));
    expect(unknown, "Siniflandirilmamis rota: IDOR testi ekle veya ORG_NEUTRAL'e bilincli ekle").toEqual([]);
    // Siniflandirmada olup artik var olmayan rota da hata (liste bayatlamasin)
    const have = new Set(apiRoutes());
    expect([...IDOR_COVERED, ...ORG_NEUTRAL].filter((r) => !have.has(r))).toEqual([]);
  });

  it("genel (oturumsuz) rotalar tam olarak PUBLIC_API_PATHS", () => {
    const publicOnes = [...ORG_NEUTRAL].filter((r) => PUBLIC_API_PATHS.has(r.split(" ")[1]!)).map((r) => r.split(" ")[1]!).sort();
    expect(publicOnes).toEqual([...PUBLIC_API_PATHS].sort());
  });

  it("OTURUMSUZ hicbir korumali rota 401'den baska yanit vermez (tum rotalar otomatik taranir)", async () => {
    for (const route of apiRoutes()) {
      const [method, path] = route.split(" ") as ["GET" | "POST", string];
      if (PUBLIC_API_PATHS.has(path)) continue;
      const url = path.replace(":id", UNKNOWN);
      const r = await api(k, method, url, { body: method === "POST" ? {} : undefined });
      expect(r.statusCode, route).toBe(401);
    }
  });

  it("SURESI DOLMUS/IPTAL oturumla da hicbir korumali rota calismaz", async () => {
    const c = await loginAs(k, "a@example.com", PW);
    await k.db.pool.query("DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email='a@example.com')");
    for (const route of apiRoutes()) {
      const [method, path] = route.split(" ") as ["GET" | "POST", string];
      if (PUBLIC_API_PATHS.has(path)) continue;
      const r = await api(k, method, path.replace(":id", devA), { cookie: c, body: method === "POST" ? {} : undefined });
      expect(r.statusCode, route).toBe(401);
    }
  });
});

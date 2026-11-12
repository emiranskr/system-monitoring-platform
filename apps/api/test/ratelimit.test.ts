import { afterAll, describe, expect, it } from "vitest";
import { createEnrollmentToken } from "../src/enrollment.js";
import { enrollBody, ping, post, setupKit, type Kit } from "./kit.js";

const kits: Kit[] = [];
afterAll(async () => { for (const k of kits) await k.close(); });

const mk = async (opts: Parameters<typeof setupKit>[0] = {}) => { const k = await setupKit(opts); kits.push(k); return k; };
const enrolled = async (k: Kit, n = 0) => {
  const t = await createEnrollmentToken(k.db.pool, k.org, { now: k.clock.now });
  const r = await post(k, "/agent/v1/enroll", enrollBody(t, { enroll_id: `f0000000-0000-4000-8000-${String(n).padStart(12, "0")}`, machine_guid: `g${n}` }));
  expect(r.statusCode).toBe(200);
  return r.json().credential as string;
};
const rows = async (k: Kit) => Number((await k.db.pool.query("SELECT count(*) FROM metric_samples")).rows[0].count);

describe("cihaz basina ingest siniri", () => {
  it("sinir asilinca 429 + Retry-After; baska cihaz etkilenmez; pencere gecince yeniden izinli", async () => {
    const k = await mk({ limits: { ingestPerDevice: 3, windowMs: 60_000 } });
    const a = await enrolled(k, 1), b = await enrolled(k, 2);
    for (let i = 0; i < 3; i++) expect((await ping(k, a, i)).statusCode).toBe(200);
    const limited = await ping(k, a, 3);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: "rate_limited" });
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect((await ping(k, b, 0)).statusCode).toBe(200); // baska cihaz etkilenmez

    k.clock.now = new Date(k.clock.now.getTime() + 61_000);
    expect((await ping(k, a, 3)).statusCode).toBe(200);
  });

  it("sinirlanan istek VERI YAZMAZ ve seq'i ilerletmez (agent ayni batch'i sonra yeniden dener)", async () => {
    const k = await mk({ limits: { ingestPerDevice: 1, windowMs: 60_000 } });
    const a = await enrolled(k, 3);
    const body = (seq: number) => ({ v: 1, spool_epoch: "11111111-1111-4111-8111-111111111111", seq, sent_at: k.clock.now.toISOString().replace(/\.\d{3}Z$/, "Z"),
      samples: [{ ts: new Date(k.clock.now.getTime() - 3000).toISOString().replace(/\.\d{3}Z$/, "Z"), m: { "a.x": 1 } }] });
    const gz = (await import("node:zlib")).gzipSync;
    const send = (seq: number) => k.app.inject({ method: "POST", url: "/agent/v1/ingest",
      headers: { "content-type": "application/json", "content-encoding": "gzip", authorization: `Bearer ${a}` }, payload: gz(Buffer.from(JSON.stringify(body(seq)))) });
    expect((await send(0)).statusCode).toBe(200);
    expect((await send(1)).statusCode).toBe(429);
    expect(await rows(k)).toBe(1);
    k.clock.now = new Date(k.clock.now.getTime() + 61_000);
    const again = await send(1); // ayni batch yeniden denenince kabul edilir
    expect(again.statusCode).toBe(200);
    expect(again.json().ack_seq).toBe(1);
  });
});

describe("IP basina basarisiz kimlik dogrulama siniri (kaba kuvvet)", () => {
  it("sinirdan sonra GECERSIZ istekler 429 alir; baska IP etkilenmez; sayac pencere gecince sifirlanir", async () => {
    const k = await mk({ limits: { failedAuthPerIp: 3, windowMs: 60_000 } });
    const req = (token: string, ip: string) => k.app.inject({ method: "POST", url: "/agent/v1/ingest", remoteAddress: ip,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, payload: "{}" });
    for (let i = 0; i < 3; i++) expect((await req("kotu_token_" + i, "10.0.0.5")).statusCode).toBe(401);
    const blocked = await req("kotu_token_9", "10.0.0.5");
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect((await req("kotu_token_9", "10.0.0.6")).statusCode).toBe(401); // baska IP: ayri sayac

    k.clock.now = new Date(k.clock.now.getTime() + 61_000);
    expect((await req("kotu_token_9", "10.0.0.5")).statusCode).toBe(401); // pencere gecti
  });
});

describe("IP basina enrollment siniri", () => {
  it("sinirdan sonra gecerli token bile 429 (token tahmini denemeleri yavaslar)", async () => {
    const k = await mk({ limits: { enrollPerIp: 2, windowMs: 60_000 } });
    const t = await createEnrollmentToken(k.db.pool, k.org, { now: k.clock.now });
    const go = (token: string, n: number, ip = "10.0.0.9") => k.app.inject({ method: "POST", url: "/agent/v1/enroll", remoteAddress: ip,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(enrollBody(token, { enroll_id: `f1000000-0000-4000-8000-${String(n).padStart(12, "0")}`, machine_guid: `x${n}` })) });
    expect((await go("x".repeat(43), 1)).statusCode).toBe(401);
    expect((await go("y".repeat(43), 2)).statusCode).toBe(401);
    const blocked = await go(t, 3);
    expect(blocked.statusCode).toBe(429);
    expect((await go(t, 4, "10.0.0.10")).statusCode).toBe(200); // baska IP, gecerli token
  });
});

describe("X-Forwarded-For ve trustProxy", () => {
  const spoof = (k: Kit, token: string, xff: string) => k.app.inject({ method: "POST", url: "/agent/v1/ingest", remoteAddress: "10.9.9.9",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-forwarded-for": xff }, payload: "{}" });

  it("trustProxy KAPALI (varsayilan): sahte X-Forwarded-For ile limit ASILAMAZ (hepsi ayni soket IP'sine sayilir)", async () => {
    const k = await mk({ limits: { failedAuthPerIp: 3, windowMs: 60_000 } });
    for (let i = 0; i < 3; i++) expect((await spoof(k, "kotu" + i, `1.2.3.${i}`)).statusCode).toBe(401);
    expect((await spoof(k, "kotu9", "99.99.99.99")).statusCode).toBe(429); // farkli sahte IP kacirmaz
  });
});

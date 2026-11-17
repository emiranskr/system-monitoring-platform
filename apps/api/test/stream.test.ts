import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { request, type IncomingMessage } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SampleBus } from "../src/events.js";
import { hashToken } from "../src/tokens.js";
import { addUser, iso, loginAs, setupKit, type Kit } from "./kit.js";

const PW = "yeterince-uzun-parola-1";
let k: Kit;
let port = 0;
let orgB = "";
let cookieA = "", cookieA2 = "", cookieB = "";
interface Dev { org: string; id: string; token: string; epoch: string; seq: number }
let devA1: Dev, devA2: Dev, devB: Dev;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 3000, what = "kosul"): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return; await sleep(20); }
  throw new Error(`Zaman asimi: ${what}`);
}

async function mkDevice(org: string, name: string): Promise<Dev> {
  const id = (await k.db.pool.query("INSERT INTO devices (org_id, name) VALUES ($1,$2) RETURNING id", [org, name])).rows[0].id as string;
  const token = `tok${randomUUID()}${randomUUID()}`.replaceAll("-", "");
  await k.db.pool.query("INSERT INTO device_tokens (token_hash, org_id, device_id) VALUES ($1,$2,$3)", [hashToken(token), org, id]);
  return { org, id, token, epoch: randomUUID(), seq: 0 };
}

/** Bir batch gonderir (gercek ingest yolu, ayni uygulama ornegi). */
async function ingest(d: Dev, values: Record<string, number | null>, seq = d.seq++) {
  const payload = { v: 1, spool_epoch: d.epoch, seq, sent_at: iso(k.clock.now), samples: [{ ts: iso(new Date(k.clock.now.getTime() - 2000)), m: values }] };
  return k.app.inject({ method: "POST", url: "/agent/v1/ingest",
    headers: { "content-type": "application/json", "content-encoding": "gzip", authorization: `Bearer ${d.token}` }, payload: gzipSync(Buffer.from(JSON.stringify(payload))) });
}

interface Sse { status: number; headers: IncomingMessage["headers"]; events: { event: string; data: string }[]; comments: number; ended: boolean; close(): void }
function openStream(cookie: string | null, query = ""): Promise<Sse> {
  return new Promise((resolve, reject) => {
    const s: Sse = { status: 0, headers: {}, events: [], comments: 0, ended: false, close: () => req.destroy() };
    const req = request({ host: "127.0.0.1", port, path: `/api/v1/stream${query}`, headers: cookie ? { cookie } : {} }, (res) => {
      s.status = res.statusCode ?? 0; s.headers = res.headers;
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        buf += c;
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          if (block.startsWith(":")) { s.comments++; continue; }
          const ev = /^event: (.*)$/m.exec(block)?.[1] ?? "message", data = /^data: (.*)$/m.exec(block)?.[1] ?? "";
          if (block.trim().length > 0) s.events.push({ event: ev, data });
        }
      });
      res.on("end", () => { s.ended = true; });
      res.on("close", () => { s.ended = true; });
      resolve(s);
    });
    req.on("error", (e) => { if (!s.ended) { s.ended = true; if (!s.status) reject(e); } });
    req.end();
  });
}
const samples = (s: Sse) => s.events.filter((e) => e.event === "sample").map((e) => JSON.parse(e.data));

beforeAll(async () => {
  k = await setupKit({ stream: { heartbeatMs: 100, revalidateMs: 150 } });
  orgB = (await k.db.pool.query("INSERT INTO orgs (name) VALUES ('B') RETURNING id")).rows[0].id;
  devA1 = await mkDevice(k.org, "a1"); devA2 = await mkDevice(k.org, "a2"); devB = await mkDevice(orgB, "b1");
  await addUser(k, "a@example.com", PW, "viewer"); await addUser(k, "a2@example.com", PW, "viewer");
  await addUser(k, "b@example.com", PW, "viewer", orgB);
  cookieA = await loginAs(k, "a@example.com", PW); cookieA2 = await loginAs(k, "a2@example.com", PW); cookieB = await loginAs(k, "b@example.com", PW);
  await k.app.listen({ port: 0, host: "127.0.0.1" });
  port = (k.app.server.address() as { port: number }).port;
}, 120_000);
afterAll(async () => { await k?.close(); });

describe("SampleBus", () => {
  it("abonesiz publish hicbir sey yapmaz; org'a gore yonlendirir; hatali abone digerlerini engellemez ve disari firlatmaz", () => {
    const bus = new SampleBus();
    const got: string[] = [];
    expect(() => bus.publish({ orgId: "x", deviceId: "d", t: "t", values: {} })).not.toThrow();
    expect(bus.hasSubscribers("x")).toBe(false);
    const u1 = bus.subscribe("o1", () => { throw new Error("abone hatasi"); });
    const u2 = bus.subscribe("o1", (e) => got.push(e.deviceId));
    bus.subscribe("o2", () => got.push("YANLIS-ORG"));
    expect(bus.size).toBe(3);
    expect(() => bus.publish({ orgId: "o1", deviceId: "d1", t: "t", values: {} })).not.toThrow();
    expect(got).toEqual(["d1"]);
    u1(); u2();
    expect(bus.size).toBe(1);
    expect(bus.hasSubscribers("o1")).toBe(false);
  });
});

describe("GET /api/v1/stream", () => {
  it("cerezsiz 401", async () => {
    const s = await openStream(null);
    expect(s.status).toBe(401);
    s.close();
  });

  it("baglanti: text/event-stream, ready olayi; ingest sonrasi cihazin son degerleri gelir", async () => {
    const s = await openStream(cookieA);
    try {
      expect(s.status).toBe(200);
      expect(String(s.headers["content-type"])).toContain("text/event-stream");
      expect(s.headers["cache-control"]).toContain("no-cache");
      await waitFor(() => s.events.some((e) => e.event === "ready"), 2000, "ready");
      expect((await ingest(devA1, { "cpu.total": 12.5, "mem.used_pct": 40, "gpu.temp": null })).statusCode).toBe(200);
      await waitFor(() => samples(s).length >= 1, 3000, "sample olayi");
      expect(samples(s)[0]).toMatchObject({ device_id: devA1.id, values: { "cpu.total": 12.5, "mem.used_pct": 40, "gpu.temp": null } });
    } finally { s.close(); }
  });

  it("IDOR: org B kullanicisi org A cihazinin olayini ALMAZ; A cihazini isterse 404", async () => {
    const s = await openStream(cookieB);
    const sA = await openStream(cookieA); // A'nin da abonesi olmali: aksi halde ingest hic yayinlamaz ve sizinti gorunmez
    const denied = await openStream(cookieB, `?devices=${devA1.id}`);
    try {
      expect(s.status).toBe(200);
      expect(denied.status).toBe(404);
      await waitFor(() => s.events.some((e) => e.event === "ready") && sA.events.some((e) => e.event === "ready"), 2000, "ready");
      await ingest(devA1, { "x.idor": 1 });
      await ingest(devB, { "x.idor": 2 });
      await waitFor(() => samples(s).length >= 1 && samples(sA).length >= 1, 3000, "her iki org'un olayi");
      await sleep(150);
      expect(samples(s).map((x) => x.device_id)).toEqual([devB.id]); // B yalniz kendi org'unu gorur
      expect(samples(sA).map((x) => x.device_id)).toEqual([devA1.id]); // A yalniz kendisini
    } finally { s.close(); sA.close(); denied.close(); }
  });

  it("devices filtresi: yalniz istenen cihazlarin olaylari; olmayan/uuid olmayan cihaz 404", async () => {
    const s = await openStream(cookieA, `?devices=${devA1.id}`);
    try {
      await waitFor(() => s.events.some((e) => e.event === "ready"), 2000, "ready");
      await ingest(devA2, { "cpu.total": 5 });
      await ingest(devA1, { "cpu.total": 6 });
      await waitFor(() => samples(s).length >= 1, 3000, "filtreli olay");
      await sleep(150);
      expect(samples(s).map((x) => x.device_id)).toEqual([devA1.id]);
    } finally { s.close(); }
    for (const bad of ["abc", "00000000-0000-4000-8000-000000000000"]) {
      const r = await openStream(cookieA, `?devices=${bad}`);
      expect(r.status, bad).toBe(404);
      r.close();
    }
  });

  it("yayin hatasi ingest'i BOZMAZ: abone firlatsa da istek 200 ve veri yazilir", async () => {
    const unsub = k.app.sampleBus.subscribe(k.org, () => { throw new Error("abone patladi"); });
    try {
      const r = await ingest(devA1, { "x.publish": 99 });
      expect(r.statusCode).toBe(200);
      expect(r.json().ack_seq).toBeGreaterThanOrEqual(0);
      expect(Number((await k.db.pool.query("SELECT count(*) FROM metric_samples WHERE device_id=$1 AND metric='x.publish' AND value=99", [devA1.id])).rows[0].count)).toBe(1);
    } finally { unsub(); }
  });

  it("yinelenen (replay) batch ikinci kez YAYINLANMAZ", async () => {
    const s = await openStream(cookieA, `?devices=${devA2.id}`);
    try {
      await waitFor(() => s.events.some((e) => e.event === "ready"), 2000, "ready");
      const seq = devA2.seq++;
      await ingest(devA2, { "cpu.total": 7 }, seq);
      await waitFor(() => samples(s).length === 1, 3000, "ilk olay");
      await ingest(devA2, { "cpu.total": 7 }, seq); // ayni seq: replay
      await sleep(200);
      expect(samples(s)).toHaveLength(1);
    } finally { s.close(); }
  });

  it("kullanici basina en cok 3 baglanti: 4.'su 429; biri kapaninca yer acilir", async () => {
    const open: Sse[] = [];
    try {
      for (let i = 0; i < 3; i++) { const s = await openStream(cookieA2); expect(s.status).toBe(200); open.push(s); }
      const fourth = await openStream(cookieA2);
      expect(fourth.status).toBe(429);
      fourth.close();
      open[0]!.close();
      await waitFor(() => k.app.sampleBus.size <= 2 + 0, 3000, "baglanti kapandi");
      await sleep(100);
      const again = await openStream(cookieA2);
      expect(again.status).toBe(200);
      open.push(again);
    } finally { open.forEach((s) => s.close()); }
  });

  // I-2 (bagimsiz inceleme): cihaz suzgeci cozulurken (DB await'leri) kopan istek, sayac/abonelik/zamanlayici sizdiriyordu;
  // kullanici (surec yeniden baslayana kadar) 429 ile kilitleniyordu.
  it("suzgec cozulurken KOPAN istekler sayac/abonelik SIZDIRMAZ: sonra yeni akis acilir (429 degil)", async () => {
    const leaker = await addUser(k, "leak@example.com", PW, "viewer");
    void leaker;
    const c = await loginAs(k, "leak@example.com", PW);
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) ids.push((await k.db.pool.query("INSERT INTO devices (org_id, name) VALUES ($1,$2) RETURNING id", [k.org, `leak-${i}`])).rows[0].id);
    const before = k.app.sampleBus.size;
    await Promise.all(Array.from({ length: 6 }, () => new Promise<void>((resolve) => {
      const req = request({ host: "127.0.0.1", port, path: `/api/v1/stream?devices=${ids.join(",")}`, headers: { cookie: c } });
      req.on("error", () => resolve());
      req.on("close", () => resolve());
      req.end();
      setTimeout(() => req.destroy(), 5); // 50 cihazin DB cozumu sirasinda kopar
    })));
    await sleep(1500); // sunucu tarafi cozumlerin bitmesi icin
    expect(k.app.sampleBus.size).toBe(before);
    const fresh = await openStream(c);
    try { expect(fresh.status).toBe(200); } finally { fresh.close(); }
  });

  it("istemci kopunca abonelik temizlenir (bus.size geri duser)", async () => {
    await sleep(100);
    const before = k.app.sampleBus.size;
    const s = await openStream(cookieA);
    await waitFor(() => k.app.sampleBus.size === before + 1, 2000, "abone eklendi");
    s.close();
    await waitFor(() => k.app.sampleBus.size === before, 3000, "abone silindi");
  });

  it("kalp atisi: bos akista da periyodik yorum satiri gelir", async () => {
    const s = await openStream(cookieA);
    try { await waitFor(() => s.comments >= 2, 3000, "ping"); } finally { s.close(); }
  });

  it("oturum iptal edilince akis yeniden dogrulamada KAPANIR (closed olayi)", async () => {
    const c = await loginAs(k, "a@example.com", PW);
    const s = await openStream(c);
    try {
      await waitFor(() => s.events.some((e) => e.event === "ready"), 2000, "ready");
      await k.db.pool.query("DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email='a@example.com')");
      await waitFor(() => s.ended, 3000, "akis kapandi");
      expect(s.events.some((e) => e.event === "closed")).toBe(true);
    } finally { s.close(); }
  });

  it("devre disi birakilan kullanicinin akisi kapanir", async () => {
    const c = await loginAs(k, "a2@example.com", PW);
    const s = await openStream(c);
    try {
      await waitFor(() => s.events.some((e) => e.event === "ready"), 2000, "ready");
      await k.db.pool.query("UPDATE users SET disabled_at=now() WHERE email='a2@example.com'");
      await waitFor(() => s.ended, 3000, "akis kapandi");
    } finally { s.close(); await k.db.pool.query("UPDATE users SET disabled_at=NULL WHERE email='a2@example.com'"); }
  });
});

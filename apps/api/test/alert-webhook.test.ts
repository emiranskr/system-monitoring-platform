import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sendWebhook, signWebhook, verifyWebhookSignature, type WebhookOptions } from "../src/alerts/webhook.js";

interface Hit { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }
let hits: Hit[] = [];
let mode: "ok" | "500" | "400" | "429" | "redirect" | "hang" | "big" = "ok";
let server: http.Server;
let port: number;
let other: http.Server;       // yonlendirme hedefi
let otherHits = 0;

const DEV: WebhookOptions = { allowPrivate: true, allowInsecureHttp: true, timeoutMs: 1500 };
const payload = { kind: "firing", dedupe_key: "inc-1:firing", rule_name: "r", device_name: "d" };

beforeAll(async () => {
  other = http.createServer((_q, s) => { otherHits++; s.end("hedef"); });
  await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      hits.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (mode === "500") { res.statusCode = 500; res.end("hata"); }
      else if (mode === "400") { res.statusCode = 400; res.end("kotu"); }
      else if (mode === "429") { res.statusCode = 429; res.end("yavas"); }
      else if (mode === "redirect") { res.statusCode = 302; res.setHeader("location", `http://127.0.0.1:${(other.address() as AddressInfo).port}/x`); res.end(); }
      else if (mode === "hang") { /* cevap yok */ }
      else if (mode === "big") { res.statusCode = 200; res.write(Buffer.alloc(200_000, 65)); res.end(Buffer.alloc(200_000, 66)); }
      else res.end("tamam");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await new Promise((r) => other.close(r));
});
const reset = (m: typeof mode = "ok") => { hits = []; otherHits = 0; mode = m; };
const url = (path = "/hook") => `http://127.0.0.1:${port}${path}`;

describe("webhook gonderici", () => {
  it("2xx: basarili; POST JSON govde; dedupe ve imza basliklari", async () => {
    reset();
    const secret = "imza-SIRRI";
    const r = await sendWebhook({ url: url("/a/b?x=1"), secret }, payload, DEV);
    expect(r).toEqual({ ok: true, retryable: false });
    expect(hits).toHaveLength(1);
    const h = hits[0]!;
    expect(h.method).toBe("POST");
    expect(h.url).toBe("/a/b?x=1");
    expect(JSON.parse(h.body)).toEqual(payload);
    expect(h.headers["content-type"]).toContain("application/json");
    expect(h.headers["x-sysmon-dedupe"]).toBe("inc-1:firing");
    // zaman damgali imza: HMAC(secret, "<ts>.<govde>"); ts ayri baslikta (saniye)
    const ts = String(h.headers["x-sysmon-timestamp"]);
    expect(ts).toMatch(/^[0-9]{10}$/);
    expect(h.headers["x-sysmon-signature"]).toBe(`sha256=${createHmac("sha256", secret).update(`${ts}.${h.body}`).digest("hex")}`);
    expect(verifyWebhookSignature({ secret, body: h.body, timestamp: ts, signature: String(h.headers["x-sysmon-signature"]), now: new Date() })).toBe(true);
  });

  it("imza dogrulama: eski (tolerans disi), degistirilmis govde/zaman damgasi, yanlis sir ve bozuk bicim REDDEDILIR; sinirda kabul", () => {
    const secret = "s", body = '{"a":1}', now = new Date("2026-11-18T12:00:00Z");
    const ts = String(Math.floor(now.getTime() / 1000));
    const sig = signWebhook(secret, ts, body);
    const v = (o: Partial<{ secret: string; body: string; timestamp: string; signature: string; now: Date; toleranceSec: number }> = {}) =>
      verifyWebhookSignature({ secret, body, timestamp: ts, signature: sig, now, ...o });
    expect(v()).toBe(true);
    expect(v({ body: '{"a":2}' })).toBe(false);                                   // govde degisti
    expect(v({ secret: "baska" })).toBe(false);
    expect(v({ timestamp: String(Number(ts) + 1) })).toBe(false);                 // zaman damgasi degisti (imza ts'yi kapsar)
    expect(v({ signature: "sha256=" + "0".repeat(64) })).toBe(false);
    expect(v({ signature: "xx" })).toBe(false);
    expect(v({ timestamp: "abc" })).toBe(false);
    const old = new Date(now.getTime() + 301_000);                                // varsayilan tolerans 300 sn: eski istek (replay)
    expect(v({ now: old })).toBe(false);
    expect(v({ now: new Date(now.getTime() + 300_000) })).toBe(true);             // sinirda kabul
    expect(v({ now: new Date(now.getTime() - 301_000) })).toBe(false);            // gelecekten gelen de reddedilir
    expect(v({ now: old, toleranceSec: 600 })).toBe(true);
  });

  it("imza sirri yoksa imza basligi gonderilmez", async () => {
    reset();
    await sendWebhook({ url: url() }, payload, DEV);
    expect(hits[0]!.headers["x-sysmon-signature"]).toBeUndefined();
  });

  it("5xx ve 429: basarisiz ve YENIDEN DENENEBILIR; diger 4xx: kalici hata", async () => {
    reset("500");
    expect(await sendWebhook({ url: url() }, payload, DEV)).toMatchObject({ ok: false, retryable: true });
    reset("429");
    expect(await sendWebhook({ url: url() }, payload, DEV)).toMatchObject({ ok: false, retryable: true });
    reset("400");
    expect(await sendWebhook({ url: url() }, payload, DEV)).toMatchObject({ ok: false, retryable: false });
  });

  it("YONLENDIRME TAKIP EDILMEZ: 302 hata sayilir, hedefe ISTEK GITMEZ", async () => {
    reset("redirect");
    const r = await sendWebhook({ url: url() }, payload, DEV);
    expect(r.ok).toBe(false);
    expect(otherHits).toBe(0);
  });

  it("zaman asimi: cevap vermeyen sunucu icin sinirli surede basarisiz (yeniden denenebilir)", async () => {
    reset("hang");
    const t = Date.now();
    const r = await sendWebhook({ url: url() }, payload, { ...DEV, timeoutMs: 300 });
    expect(r).toMatchObject({ ok: false, retryable: true });
    expect(Date.now() - t).toBeLessThan(3000);
  });

  it("buyuk yanit govdesi sinirlanir (okuma kesilir) ama 2xx basari sayilir", async () => {
    reset("big");
    const r = await sendWebhook({ url: url() }, payload, { ...DEV, maxResponseBytes: 1024 });
    expect(r.ok).toBe(true);
  });

  it("I-3: gecici DNS hatasi (EAI_AGAIN) YENIDEN DENENEBILIR; engelli adres kalici", async () => {
    const dnsFail = async () => { throw Object.assign(new Error("EAI_AGAIN"), { code: "EAI_AGAIN" }); };
    expect(await sendWebhook({ url: "https://hooks.example.com/x" }, payload, { allowPrivate: false, timeoutMs: 1000, lookup: dnsFail })).toMatchObject({ ok: false, retryable: true });
    expect(await sendWebhook({ url: "https://hooks.example.com/x" }, payload, { allowPrivate: false, timeoutMs: 1000, lookup: async () => [{ address: "10.0.0.5", family: 4 }] })).toMatchObject({ ok: false, retryable: false });
  });

  it("SSRF: allowPrivate kapaliyken loopback/ozel hedefe ISTEK GITMEZ ve kalici hata (yeniden deneme yok)", async () => {
    reset();
    const r = await sendWebhook({ url: url() }, payload, { allowPrivate: false, allowInsecureHttp: true, timeoutMs: 1000 });
    expect(r).toMatchObject({ ok: false, retryable: false });
    expect(hits).toHaveLength(0);
    for (const u of ["http://169.254.169.254/latest/meta-data", "https://[::1]/x", "https://10.0.0.5/x", "https://192.168.1.1/x"]) {
      expect(await sendWebhook({ url: u }, payload, { allowPrivate: false, allowInsecureHttp: true, timeoutMs: 1000 })).toMatchObject({ ok: false, retryable: false });
    }
  });

  it("uretim kipinde (allowInsecureHttp=false) http:// reddedilir; kimlik bilgisi iceren URL ve gecersiz sema reddedilir", async () => {
    reset();
    const strict: WebhookOptions = { allowPrivate: true, allowInsecureHttp: false, timeoutMs: 1000 };
    expect(await sendWebhook({ url: url() }, payload, strict)).toMatchObject({ ok: false, retryable: false });
    expect(await sendWebhook({ url: `http://user:pass@127.0.0.1:${port}/x` }, payload, DEV)).toMatchObject({ ok: false, retryable: false });
    expect(await sendWebhook({ url: "ftp://example.com/x" }, payload, DEV)).toMatchObject({ ok: false, retryable: false });
    expect(await sendWebhook({ url: "bu bir url degil" }, payload, DEV)).toMatchObject({ ok: false, retryable: false });
    expect(hits).toHaveLength(0);
  });

  it("DNS: ad TEK KEZ cozumlenir ve baglanti O adrese yapilir (rebinding yok); karma cevap reddedilir", async () => {
    reset();
    let calls = 0;
    const lookup = async () => { calls++; return [{ address: "127.0.0.1", family: 4 }]; };
    const r = await sendWebhook({ url: `http://hook.test:${port}/p` }, payload, { ...DEV, lookup });
    expect(r.ok).toBe(true);
    expect(calls).toBe(1);
    expect(hits[0]!.headers.host).toBe(`hook.test:${port}`);          // Host basligi asil ad (adres degil)

    reset();
    const mixed = async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }];
    expect(await sendWebhook({ url: `http://hook.test:${port}/p` }, payload, { allowPrivate: false, allowInsecureHttp: true, timeoutMs: 1000, lookup: mixed })).toMatchObject({ ok: false, retryable: false });
    expect(hits).toHaveLength(0);
  });

  it("baglanti, cozumlenen ADRESE yapilir (127.0.0.2'deki alici; baska adrese sapma yok)", async () => {
    const s2 = http.createServer((_q, res) => { hits.push({ method: "POST", url: "/s2", headers: {}, body: "" }); res.end("ok"); });
    await new Promise<void>((r) => s2.listen(0, "127.0.0.2", r));
    try {
      reset();
      const p2 = (s2.address() as AddressInfo).port;
      const r = await sendWebhook({ url: `http://pinned.test:${p2}/x` }, payload, { ...DEV, lookup: async () => [{ address: "127.0.0.2", family: 4 }] });
      expect(r.ok).toBe(true);
      expect(hits.map((h) => h.url)).toEqual(["/s2"]);
    } finally { await new Promise((r) => s2.close(r)); }
  });

  it("hata metni URL'nin yolunu/sorgusunu (gizli token) ICERMEZ", async () => {
    reset("500");
    const r = await sendWebhook({ url: url("/services/T0/B0/TOKEN-SIRRI?key=SIRR2") }, payload, DEV);
    expect(JSON.stringify(r)).not.toContain("TOKEN-SIRRI");
    expect(JSON.stringify(r)).not.toContain("SIRR2");
    const down = await sendWebhook({ url: "http://127.0.0.1:1/TOKEN-SIRRI" }, payload, DEV);   // baglanti reddi
    expect(JSON.stringify(down)).not.toContain("TOKEN-SIRRI");
  });
});

const haveOpenssl = spawnSync("openssl", ["version"]).status === 0;
describe.skipIf(!haveOpenssl)("webhook TLS dogrulamasi (openssl ile gecici sertifika)", () => {
  let dir: string;
  let tlsServer: https.Server;
  let tlsPort: number;
  let cert: string;
  let tlsHits = 0;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sysmon-wh-"));
    const r = spawnSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"),
      "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"]);
    if (r.status !== 0) throw new Error("openssl basarisiz: " + r.stderr);
    cert = readFileSync(join(dir, "c.pem"), "utf8");
    tlsServer = https.createServer({ key: readFileSync(join(dir, "k.pem")), cert }, (_q, s) => { tlsHits++; s.end("tls-tamam"); });
    await new Promise<void>((res) => tlsServer.listen(0, "127.0.0.1", res));
    tlsPort = (tlsServer.address() as AddressInfo).port;
  });
  afterAll(async () => {
    tlsServer.closeAllConnections();
    await new Promise((r) => tlsServer.close(r));
    rmSync(dir, { recursive: true, force: true });
  });
  const lookupLocal = async () => [{ address: "127.0.0.1", family: 4 }];
  const base: WebhookOptions = { allowPrivate: true, allowInsecureHttp: false, timeoutMs: 3000, lookup: lookupLocal };

  it("guvenilmeyen (kendinden imzali) sertifika REDDEDILIR (rejectUnauthorized kapatilamaz)", async () => {
    tlsHits = 0;
    const r = await sendWebhook({ url: `https://localhost:${tlsPort}/x` }, payload, base);
    expect(r.ok).toBe(false);
    expect(tlsHits).toBe(0);
  });

  it("guvenilen CA + dogru ana makine adi ile basarili", async () => {
    tlsHits = 0;
    const r = await sendWebhook({ url: `https://localhost:${tlsPort}/x` }, payload, { ...base, tlsCa: cert });
    expect(r.ok).toBe(true);
    expect(tlsHits).toBe(1);
  });

  it("ana makine adi uyusmazligi (sertifika localhost icin, URL baska ad) REDDEDILIR", async () => {
    tlsHits = 0;
    const r = await sendWebhook({ url: `https://baska-ad.test:${tlsPort}/x` }, payload, { ...base, tlsCa: cert });
    expect(r.ok).toBe(false);
    expect(tlsHits).toBe(0);
  });
});

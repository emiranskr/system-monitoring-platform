import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sendEmail, type EmailConfig, type EmailOptions } from "../src/alerts/email.js";
import { FakeSmtp } from "./fake-smtp.js";

const payload = { kind: "firing", incident_id: "inc-1", dedupe_key: "inc-1:firing", rule_name: "CPU yuksek", device_name: "PC-01", metric: "cpu.total", severity: "critical", value: 95.5, operator: ">", threshold: 90, opened_at: "2026-11-18T12:00:00.000Z", resolved_at: null };
const DEV: EmailOptions = { allowPrivate: true, allowInsecure: true, timeoutMs: 3000 };
const cfg = (port: number, over: Partial<EmailConfig> = {}): EmailConfig => ({ host: "127.0.0.1", port, from: "alarm@example.com", to: ["ali@example.com"], ...over });
let smtp: FakeSmtp | undefined;
afterEach(async () => { await smtp?.stop(); smtp = undefined; });
const start = async (opts?: ConstructorParameters<typeof FakeSmtp>[0]) => { smtp = new FakeSmtp(opts); await smtp.start(); return smtp; };

describe("e-posta gondericisi (sahte SMTP)", () => {
  it("baglanti, kimlik dogrulama ve gonderim: zarf + govde dogru; konu/govde olay bilgisini icerir", async () => {
    const s = await start({ user: "kullanici", pass: "PAROLA-SIRRI" });
    const r = await sendEmail(cfg(s.port, { user: "kullanici", pass: "PAROLA-SIRRI", to: ["ali@example.com", "veli@example.com"] }), payload, DEV);
    expect(r).toEqual({ ok: true, retryable: false });
    expect(s.messages).toHaveLength(1);
    const m = s.messages[0]!;
    expect(m.from).toBe("alarm@example.com");
    expect(m.to).toEqual(["ali@example.com", "veli@example.com"]);
    expect(m.authUser).toBe("kullanici");
    expect(m.authPass).toBe("PAROLA-SIRRI");
    expect(m.data).toContain("CPU yuksek");
    expect(m.data).toContain("PC-01");
    expect(m.data).toMatch(/^Subject: /m);                           // Turkce karakterli konu RFC2047 ile kodlanir
    expect(m.data).toContain("inc-1:firing");                       // tekilleştirme kimligi baslikta/govdede
  });

  it("yanlis kimlik bilgisi: kalici hata (yeniden deneme yok) ve HATA METNI PAROLAYI ICERMEZ", async () => {
    const s = await start({ user: "kullanici", pass: "dogru" });
    const r = await sendEmail(cfg(s.port, { user: "kullanici", pass: "YANLIS-PAROLA-SIRRI" }), payload, DEV);
    expect(r).toMatchObject({ ok: false, retryable: false });
    expect(JSON.stringify(r)).not.toContain("YANLIS-PAROLA-SIRRI");
    expect(JSON.stringify(r)).not.toContain("kullanici");
    expect(s.messages).toHaveLength(0);
  });

  it("gecici alici hatasi (451): yeniden denenebilir; kalici (550): yeniden denenemez", async () => {
    let s = await start({ mode: "rcptTemp" });
    expect(await sendEmail(cfg(s.port), payload, DEV)).toMatchObject({ ok: false, retryable: true });
    await s.stop();
    s = smtp = new FakeSmtp({ mode: "rcptPerm" });
    await s.start();
    expect(await sendEmail(cfg(s.port), payload, DEV)).toMatchObject({ ok: false, retryable: false });
  });

  it("zaman asimi: selamlamayan sunucu icin sinirli surede basarisiz (yeniden denenebilir)", async () => {
    const s = await start({ mode: "hang" });
    const t = Date.now();
    const r = await sendEmail(cfg(s.port), payload, { ...DEV, timeoutMs: 400 });
    expect(r).toMatchObject({ ok: false, retryable: true });
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it("SSRF: allowPrivate kapaliyken ozel/loopback SMTP hedefine BAGLANILMAZ ve kalici hata", async () => {
    const s = await start();
    const r = await sendEmail(cfg(s.port), payload, { allowPrivate: false, allowInsecure: true, timeoutMs: 1000 });
    expect(r).toMatchObject({ ok: false, retryable: false });
    expect(s.connections).toBe(0);
    for (const host of ["169.254.169.254", "10.0.0.5", "192.168.1.1", "::1"])
      expect(await sendEmail(cfg(25, { host }), payload, { allowPrivate: false, allowInsecure: true, timeoutMs: 500 })).toMatchObject({ ok: false, retryable: false });
  });

  it("TLS ZORUNLU (uretim): TLS sunmayan sunucuya duz metin gonderilmez, KIMLIK BILGISI SIZMAZ", async () => {
    const s = await start({ user: "k", pass: "p" });
    const r = await sendEmail(cfg(s.port, { user: "k", pass: "p" }), payload, { allowPrivate: true, allowInsecure: false, timeoutMs: 2000 });
    expect(r.ok).toBe(false);
    expect(s.messages).toHaveLength(0);
    expect(s.connections).toBeGreaterThanOrEqual(1);
  });

  it("alici/gonderen dogrulamasi: gecersiz adres, CRLF enjeksiyonu, cok alici, bos liste reddedilir (baglanti kurulmaz)", async () => {
    const s = await start();
    for (const bad of [
      cfg(s.port, { to: [] }),
      cfg(s.port, { to: ["gecersiz"] }),
      cfg(s.port, { to: ["a@example.com\r\nBcc: x@evil.test"] }),
      cfg(s.port, { from: "a@example.com\r\nX: y" }),
      cfg(s.port, { to: Array.from({ length: 11 }, (_, i) => `u${i}@example.com`) }),
    ]) expect(await sendEmail(bad, payload, DEV)).toMatchObject({ ok: false, retryable: false });
    expect(s.connections).toBe(0);
  });

  it("konu satirina CRLF enjekte edilemez (kural/cihaz adi kullanici girdisidir)", async () => {
    const s = await start();
    const evil = { ...payload, rule_name: "kural\r\nBcc: kurban@evil.test", device_name: "pc\r\nX-Evil: 1" };
    await sendEmail(cfg(s.port), evil, DEV);
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]!.to).toEqual(["ali@example.com"]);          // Bcc zarfa girmedi
    const headers = s.messages[0]!.data.split("\r\n\r\n")[0]!;
    expect(headers).not.toMatch(/^Bcc:/im);
    expect(headers).not.toMatch(/^X-Evil:/im);
  });
});

const haveOpenssl = spawnSync("openssl", ["version"]).status === 0;
describe.skipIf(!haveOpenssl)("e-posta TLS (ortuk TLS, openssl ile gecici sertifika)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sysmon-smtp-"));
  let key = "", cert = "";
  const gen = () => {
    if (cert) return;
    const r = spawnSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"]);
    if (r.status !== 0) throw new Error("openssl basarisiz");
    key = readFileSync(join(dir, "k.pem"), "utf8");
    cert = readFileSync(join(dir, "c.pem"), "utf8");
  };
  afterEach(() => { /* dizin test sonunda */ });
  const lookupLocal = async () => [{ address: "127.0.0.1", family: 4 }];
  const base: EmailOptions = { allowPrivate: true, allowInsecure: false, timeoutMs: 4000, lookup: lookupLocal };

  it("guvenilmeyen sertifika REDDEDILIR; guvenilen CA + dogru ad ile basarili; ad uyusmazligi reddedilir", async () => {
    gen();
    const s = await start({ tls: { key, cert } });
    expect((await sendEmail(cfg(s.port, { host: "localhost", secure: true }), payload, base)).ok).toBe(false);
    expect(s.messages).toHaveLength(0);
    expect((await sendEmail(cfg(s.port, { host: "localhost", secure: true }), payload, { ...base, tlsCa: cert })).ok).toBe(true);
    expect(s.messages).toHaveLength(1);
    expect((await sendEmail(cfg(s.port, { host: "baska-ad.test", secure: true }), payload, { ...base, tlsCa: cert })).ok).toBe(false);
    expect(s.messages).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });
});

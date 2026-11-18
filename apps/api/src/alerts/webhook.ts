import { createHmac } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { resolveSafe, SsrfError, type LookupAll } from "./net-guard.js";

export interface WebhookConfig { url: string; /** Istege bagli HMAC-SHA256 imza sirri (X-Sysmon-Signature). */ secret?: string }
export interface WebhookOptions {
  /** YALNIZ gelistirme/test: ozel/loopback adreslere izin. Uretimde false. */
  allowPrivate: boolean;
  /** YALNIZ gelistirme/test: http:// izni. Uretimde HTTPS zorunlu. */
  allowInsecureHttp: boolean;
  timeoutMs: number;
  maxResponseBytes?: number;
  /** Test: DNS cozumleyici. */
  lookup?: LookupAll;
  /** Test: guvenilen CA (PEM). Uretimde sistem CA'lari; rejectUnauthorized ASLA kapatilmaz. */
  tlsCa?: string;
}
export interface SendResult { ok: boolean; retryable: boolean; error?: string }

const MAX_RESPONSE = 64 * 1024;

const fail = (retryable: boolean, error: string): SendResult => ({ ok: false, retryable, error });

/**
 * Webhook: POST JSON. Guvenlik: HTTPS zorunlu (uretim), URL'de kimlik bilgisi yok, hedef adres cozumlenip ENGELLI araliklara karsi
 * dogrulanir ve baglanti AYNI adrese yapilir (DNS rebinding yok), yonlendirme TAKIP EDILMEZ (3xx hata), TLS sertifika + ana makine
 * adi dogrulamasi acik, zaman asimi ve yanit govdesi siniri var. Hata metinleri URL yolu/sorgusunu (gizli token) ICERMEZ.
 */
export async function sendWebhook(cfg: WebhookConfig, payload: unknown, opts: WebhookOptions): Promise<SendResult> {
  let u: URL;
  try { u = new URL(cfg.url); } catch { return fail(false, "gecersiz URL"); }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && opts.allowInsecureHttp)) return fail(false, "yalnizca https:// izinli");
  if (u.username || u.password) return fail(false, "URL kimlik bilgisi iceremez");

  let addr;
  try { addr = await resolveSafe(u.hostname, { allowPrivate: opts.allowPrivate, lookup: opts.lookup }); }
  catch (e) { return fail(!(e instanceof SsrfError), e instanceof SsrfError ? e.message : "hedef cozumlenemedi"); }

  const body = JSON.stringify(payload);
  const dedupe = (payload as { dedupe_key?: string } | null)?.dedupe_key;
  const headers: Record<string, string | number> = {
    "content-type": "application/json", "content-length": Buffer.byteLength(body), "user-agent": "sysmon-alerts/1",
    ...(dedupe ? { "x-sysmon-dedupe": String(dedupe) } : {}),
    ...(cfg.secret ? { "x-sysmon-signature": `sha256=${createHmac("sha256", cfg.secret).update(body).digest("hex")}` } : {}),
  };
  const lib = u.protocol === "https:" ? https : http;
  const max = opts.maxResponseBytes ?? MAX_RESPONSE;

  return new Promise<SendResult>((resolve) => {
    let done = false;
    const finish = (r: SendResult) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const req = lib.request({
      hostname: u.hostname.replace(/^\[|\]$/g, ""),
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      method: "POST",
      headers,
      agent: false,
      // Baglanti, dogrulanmis TEK adrese yapilir; SNI/sertifika/Host dogrulamasi asil ad uzerinden surer.
      lookup: ((_h: string, o: { all?: boolean }, cb: (err: Error | null, a: unknown, f?: number) => void) =>
        o && o.all ? cb(null, [{ address: addr.address, family: addr.family }]) : cb(null, addr.address, addr.family)) as never,
      ...(u.protocol === "https:" ? { rejectUnauthorized: true, ...(opts.tlsCa ? { ca: opts.tlsCa } : {}) } : {}),
    }, (res) => {
      const code = res.statusCode ?? 0;
      let got = 0;
      const settle = () => {
        if (code >= 200 && code < 300) finish({ ok: true, retryable: false });
        else if (code >= 300 && code < 400) finish(fail(false, `yonlendirme takip edilmez (HTTP ${code})`));
        else if (code >= 500 || code === 429 || code === 408) finish(fail(true, `HTTP ${code}`));
        else finish(fail(false, `HTTP ${code}`));
      };
      res.on("data", (c: Buffer) => { got += c.length; if (got > max) { res.destroy(); settle(); } });
      res.on("end", settle);
      res.on("error", settle);
      res.on("close", settle);
    });
    const timer = setTimeout(() => { req.destroy(); finish(fail(true, "zaman asimi")); }, opts.timeoutMs);
    req.on("error", (e: NodeJS.ErrnoException) => {
      const tls = typeof e.code === "string" && /CERT|SELF_SIGNED|UNABLE_TO|HOSTNAME|ERR_TLS/.test(e.code);
      finish(fail(!tls, tls ? "TLS sertifika dogrulamasi basarisiz" : "baglanti hatasi"));
    });
    req.end(body);
  });
}

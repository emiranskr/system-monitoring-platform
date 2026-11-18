import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { resolveSafe, SsrfError, type LookupAll } from "./net-guard.js";
import type { SendResult } from "./webhook.js";

export interface EmailConfig {
  host: string;
  port: number;
  /** Ortuk TLS (465 tarzi). false ise STARTTLS ZORUNLU (uretim). */
  secure?: boolean;
  user?: string;
  pass?: string;
  from: string;
  to: string[];
}
export interface EmailOptions {
  /** YALNIZ gelistirme/test: ozel/loopback SMTP hedeflerine izin. */
  allowPrivate: boolean;
  /** YALNIZ gelistirme/test: TLS'siz duz SMTP. Uretimde false (TLS zorunlu, sertifika dogrulamasi acik). */
  allowInsecure: boolean;
  timeoutMs: number;
  lookup?: LookupAll;
  /** Test: guvenilen CA (PEM). */
  tlsCa?: string;
}

const MAX_RECIPIENTS = 10;
const ADDR = /^[^\s@<>"',;\\]+@[^\s@<>"',;\\]+\.[^\s@<>"',;\\]+$/;
const fail = (retryable: boolean, error: string): SendResult => ({ ok: false, retryable, error });

const clean = (s: string, max: number) => s.replace(new RegExp("[\\u0000-\\u001f\\u007f\\u2028\\u2029]", "g"), " ").trim().slice(0, max);
const validAddr = (a: unknown): a is string => typeof a === "string" && a.length <= 254 && ADDR.test(a);

const SEV: Record<string, string> = { info: "BİLGİ", warning: "UYARI", critical: "KRİTİK" };

interface Payload {
  kind?: string; rule_name?: string; device_name?: string; metric?: string; severity?: string; value?: number | null;
  operator?: string; threshold?: number; opened_at?: string; resolved_at?: string | null; dedupe_key?: string; incident_id?: string;
}

/**
 * E-posta (SMTP). Guvenlik: hedef cozumlenip ENGELLI araliklara (SSRF) karsi dogrulanir ve baglanti AYNI adrese yapilir; TLS zorunlu
 * (ortuk TLS veya STARTTLS) ve sertifika + ana makine adi dogrulamasi acik; kullanici girdili alanlar (kural/cihaz adi) basliklara
 * CR/LF olmadan girer; alicilar dogrulanir. Hata sonuclari parola/kullanici/sunucu yaniti ICERMEZ.
 */
export async function sendEmail(cfg: EmailConfig, payload: unknown, opts: EmailOptions): Promise<SendResult> {
  if (!cfg || typeof cfg.host !== "string" || !cfg.host || !Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) return fail(false, "gecersiz SMTP ayari");
  if (!validAddr(cfg.from)) return fail(false, "gecersiz gonderen adresi");
  if (!Array.isArray(cfg.to) || cfg.to.length < 1 || cfg.to.length > MAX_RECIPIENTS || !cfg.to.every(validAddr)) return fail(false, "gecersiz alici listesi");

  let addr;
  try { addr = await resolveSafe(cfg.host, { allowPrivate: opts.allowPrivate, lookup: opts.lookup }); }
  catch (e) { return fail(!(e instanceof SsrfError), e instanceof SsrfError ? e.message : "SMTP hedefi cozumlenemedi"); }

  const p = (payload ?? {}) as Payload;
  const sev = SEV[p.severity ?? ""] ?? "UYARI";
  const state = p.kind === "resolved" ? "çözüldü" : p.kind === "test" ? "test" : "tetiklendi";
  const subject = clean(`[${sev}] ${p.rule_name ?? "Uyarı"} — ${p.device_name ?? "cihaz"} ${state}`, 200);
  const lines = [
    `Kural: ${clean(p.rule_name ?? "", 100)}`,
    `Cihaz: ${clean(p.device_name ?? "", 100)}`,
    `Durum: ${state}`,
    p.metric ? `Metrik: ${clean(p.metric, 64)} ${clean(p.operator ?? "", 3)} ${p.threshold ?? ""} (değer: ${p.value ?? "-"})` : "",
    `Başlangıç: ${clean(p.opened_at ?? "", 40)}`,
    p.resolved_at ? `Çözüldü: ${clean(p.resolved_at, 40)}` : "",
    p.dedupe_key ? `Olay: ${clean(p.dedupe_key, 100)}` : "",
  ].filter(Boolean);

  const transport = nodemailer.createTransport({
    host: addr.address,                                    // dogrulanmis TEK adres (DNS rebinding yok)
    port: cfg.port,
    secure: !!cfg.secure,
    ...(cfg.secure ? {} : opts.allowInsecure ? { ignoreTLS: true } : { requireTLS: true }),
    ...(cfg.user !== undefined ? { auth: { user: cfg.user, pass: cfg.pass ?? "" } } : {}),
    tls: { servername: cfg.host, rejectUnauthorized: true, ...(opts.tlsCa ? { ca: opts.tlsCa } : {}) },
    connectionTimeout: opts.timeoutMs, greetingTimeout: opts.timeoutMs, socketTimeout: opts.timeoutMs,
    disableFileAccess: true, disableUrlAccess: true,
    logger: false, debug: false,
  } as SMTPTransport.Options);

  try {
    await transport.sendMail({
      from: cfg.from, to: cfg.to, subject, text: lines.join("\r\n"),
      ...(p.dedupe_key ? { headers: { "X-Sysmon-Dedupe": clean(p.dedupe_key, 100) } } : {}),
    });
    return { ok: true, retryable: false };
  } catch (e) {
    const err = e as { code?: string; responseCode?: number; message?: string };
    const msg = String(err.message ?? "");
    if (err.code === "EAUTH") return fail(false, "SMTP kimlik doğrulaması başarısız");
    if (/certificate|self.signed|hostname|altnames|STARTTLS|TLS/i.test(msg) && err.code !== "ETIMEDOUT") return fail(false, "TLS doğrulaması/zorunluluğu başarısız");
    if (typeof err.responseCode === "number") return fail(err.responseCode >= 400 && err.responseCode < 500, `SMTP ${err.responseCode}`);
    if (err.code === "EENVELOPE" || err.code === "EMESSAGE") return fail(false, "SMTP zarf/ileti reddedildi");
    return fail(true, err.code === "ETIMEDOUT" ? "SMTP zaman aşımı" : "SMTP bağlantı hatası");
  } finally {
    transport.close();
  }
}

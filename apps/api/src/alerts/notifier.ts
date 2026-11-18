import type pg from "pg";
import { sendEmail, type EmailConfig, type EmailOptions } from "./email.js";
import { channelAad, decryptSecret } from "./secrets.js";
import { sendWebhook, type SendResult, type WebhookConfig, type WebhookOptions } from "./webhook.js";

export interface NotifierDeps {
  /** Kanal sir anahtari (AES-256-GCM). Yok/gecersizse gonderim YAPILMAZ. */
  secretKey: Buffer | undefined;
  now: () => Date;
  webhook: WebhookOptions;
  email: EmailOptions;
  /** Azami teslimat denemesi (varsayilan 8). */
  maxAttempts?: number;
  /** Kanal basina dakikada azami gonderim (varsayilan 20). */
  ratePerMinute?: number;
  /** 'sending' kirasi (varsayilan 60 sn): calisan cokerse bu sureden sonra satir yeniden alinir. */
  leaseMs?: number;
  /** Tur basina azami bildirim (varsayilan 25). */
  batch?: number;
}
export interface NotifyResult { sent: number; retried: number; failed: number }

interface Claimed { id: string; org_id: string; channel_id: string; kind: string; attempts: number; payload: unknown }

const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 15 * 60_000;
const RATE_DEFER_MS = 15_000;

const backoff = (attempts: number) => Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempts - 1));

/**
 * KALICI kuyruk isleyicisi (at-least-once, mukerrer korumali):
 * - satirlar `FOR UPDATE SKIP LOCKED` ile alinip 'sending' + kira isaretlenir (es zamanli isleyiciler ayni satiri gormez);
 * - basari -> 'sent' (bir daha ASLA gonderilmez); gecici hata -> ustel geri cekilmeyle 'pending'; kalici hata/azami deneme -> 'failed';
 * - API yeniden baslarsa 'pending' ve kirasi dolmus 'sending' satirlari kaybolmaz, yeniden alinir;
 * - ayni (olay, tur, kanal) icin TEK satir (UNIQUE): yeniden deneme AYNI satiri gunceller, ek bildirim satiri olusmaz;
 * - kanal basina dakikada sinirli gonderim (fazlasi deneme hakki harcanmadan ertelenir);
 * - kanal yapilandirmasi organizasyon kimligiyle okunur, sifrelidir ve yalnizca gonderim aninda cozulur.
 */
export async function processNotifications(pool: pg.Pool, deps: NotifierDeps): Promise<NotifyResult> {
  const now = deps.now();
  const leaseUntil = new Date(now.getTime() + (deps.leaseMs ?? 60_000));
  const claimed = (await pool.query<Claimed>(
    `UPDATE notifications n SET status = 'sending', lease_until = $2, attempts = n.attempts + 1
      WHERE n.id IN (
        SELECT id FROM notifications
         WHERE (status = 'pending' AND next_attempt_at <= $1) OR (status = 'sending' AND lease_until <= $1)
         ORDER BY next_attempt_at, id LIMIT $3 FOR UPDATE SKIP LOCKED)
      RETURNING n.id, n.org_id, n.channel_id, n.kind, n.attempts, n.payload`,
    [now, leaseUntil, deps.batch ?? 25])).rows;

  const out: NotifyResult = { sent: 0, retried: 0, failed: 0 };
  const maxAttempts = deps.maxAttempts ?? 8;
  const rate = deps.ratePerMinute ?? 20;

  for (const n of claimed) {
    // Hizlimit: son 60 sn'de bu kanala gonderilen sayisi
    const recent = (await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM notifications WHERE channel_id = $1 AND status = 'sent' AND sent_at > $2", [n.channel_id, new Date(now.getTime() - 60_000)])).rows[0]!.c;
    if (recent >= rate) {
      await pool.query("UPDATE notifications SET status = 'pending', attempts = attempts - 1, lease_until = NULL, next_attempt_at = $2 WHERE id = $1",
        [n.id, new Date(now.getTime() + RATE_DEFER_MS)]);
      continue;
    }

    const result = await deliver(pool, n, deps);
    if (result.ok) {
      await pool.query("UPDATE notifications SET status = 'sent', sent_at = $2, lease_until = NULL, last_error = NULL WHERE id = $1", [n.id, now]);
      out.sent++;
    } else if (result.retryable && n.attempts < maxAttempts) {
      await pool.query("UPDATE notifications SET status = 'pending', lease_until = NULL, last_error = $3, next_attempt_at = $2 WHERE id = $1",
        [n.id, new Date(now.getTime() + backoff(n.attempts)), result.error ?? "hata"]);
      out.retried++;
    } else {
      await pool.query("UPDATE notifications SET status = 'failed', lease_until = NULL, last_error = $2 WHERE id = $1", [n.id, result.error ?? "hata"]);
      out.failed++;
    }
  }
  return out;
}

async function deliver(pool: pg.Pool, n: Claimed, deps: NotifierDeps): Promise<SendResult> {
  const ch = (await pool.query<{ type: "webhook" | "email"; config_enc: Buffer }>(
    "SELECT type, config_enc FROM notification_channels WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL", [n.channel_id, n.org_id])).rows[0];
  if (!ch) return { ok: false, retryable: false, error: "kanal yok veya silinmis" };
  let cfg: unknown;
  try { cfg = JSON.parse(decryptSecret(deps.secretKey, ch.config_enc, channelAad(n.org_id, n.channel_id))); }
  catch { return { ok: false, retryable: false, error: "kanal sirlari cozulemedi (anahtar yok/gecersiz)" }; }
  try {
    return ch.type === "webhook"
      ? await sendWebhook(cfg as WebhookConfig, n.payload, deps.webhook)
      : await sendEmail(cfg as EmailConfig, n.payload, deps.email);
  } catch {
    return { ok: false, retryable: true, error: "beklenmeyen gonderim hatasi" };
  }
}

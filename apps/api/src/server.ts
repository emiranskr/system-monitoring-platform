import { readFileSync } from "node:fs";
import { migrate } from "@sysmon/db";
import { buildApp } from "./app.js";
import { parseTrustProxy } from "./config.js";
import { alertDevFlags } from "./alerts/devflags.js";
import { parseChannelKey } from "./alerts/secrets.js";
import { purgeExpiredCredentials } from "./enrollment.js";
import { createPool } from "./pool.js";
import { ensureSetupToken } from "./users.js";

/**
 * Yapilandirma ortam degiskenleriyle: DATABASE_URL (zorunlu), CREDENTIAL_KEY (zorunlu, 32 bayt base64: credential'larin
 * yeniden deneme penceresi boyunca sifreli tutulmasi), CHANNEL_KEY (M5, 32 bayt base64: bildirim kanali sirlari AES-256-GCM; YOKSA kanal olusturma 503 ve bildirim gonderilmez),
 * ALERT_ALLOW_PRIVATE_TARGETS ("1" = YALNIZ gelistirme: ozel/loopback webhook/SMTP hedeflerine izin; SSRF korumasi KAPANIR), ALERT_ALLOW_INSECURE_WEBHOOK ("1" = YALNIZ gelistirme: http:// webhook), ALERT_EVALUATE_MS / ALERT_NOTIFY_MS (varsayilan 15000 / 5000; en az 500), PORT (8443), HOST (127.0.0.1), SPKI_PINS (virgulle ayrilmis
 * sha256/<b64>), SAMPLE_INTERVAL_SECONDS (5; agent ornekleme araligi), LOG_LEVEL (info), ALLOWED_ORIGINS (panel kokenleri, virgullu; bos = giris dahil durum degistiren /api/v1 istekleri reddedilir), SESSION_IDLE_MINUTES (30), SESSION_ABSOLUTE_HOURS (12), TRUST_PROXY (kapali; ters proxy arkasinda guvenilen proxy IP/CIDR LISTESI, orn. 127.0.0.1,10.0.0.0/8; "true" ve sayisal atlama sayisi REDDEDILIR), MIGRATE ("1" = acilista migrate).
 * TLS_CERT + TLS_KEY (PEM dosya yollari) verilirse HTTPS dinler (TLS >= 1.2); verilmezse DUZ HTTP: Agent (Release) yalnizca
 * HTTPS kabul ettiginden uretimde TLS ya burada ya da onundeki ters proxy'de sonlandirilmalidir (TRUST_PROXY ile).
 */
const url = process.env.DATABASE_URL;
const key = Buffer.from(process.env.CREDENTIAL_KEY ?? "", "base64");
if (!url || key.length !== 32) {
  console.error("DATABASE_URL ve CREDENTIAL_KEY (32 bayt, base64) zorunludur.");
  process.exit(2);
}
let devFlags;
try { devFlags = alertDevFlags(process.env); } catch (e) { console.error((e as Error).message); process.exit(2); }
const pool = createPool(url, (e) => console.error("DB havuz hatasi (bosta baglanti kopmasi olabilir):", e.message));
if (process.env.MIGRATE === "1") console.log("migrate:", await migrate(pool));

const app = buildApp({
  pool, credentialKey: key, logger: { level: process.env.LOG_LEVEL ?? "info" }, trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  https: process.env.TLS_CERT && process.env.TLS_KEY
    ? { cert: readFileSync(process.env.TLS_CERT), key: readFileSync(process.env.TLS_KEY) }
    : undefined,
  channelKey: parseChannelKey(process.env.CHANNEL_KEY),
  alerts: {
    jobs: true,
    evaluateMs: process.env.ALERT_EVALUATE_MS ? Math.max(500, Number(process.env.ALERT_EVALUATE_MS)) : undefined,   // varsayilan 15 sn; testler kisaltir
    notifyMs: process.env.ALERT_NOTIFY_MS ? Math.max(500, Number(process.env.ALERT_NOTIFY_MS)) : undefined,
    allowPrivateTargets: devFlags.allowPrivateTargets,
    allowInsecureWebhooks: devFlags.allowInsecureWebhooks,
  },
  sampleIntervalSeconds: process.env.SAMPLE_INTERVAL_SECONDS ? Number(process.env.SAMPLE_INTERVAL_SECONDS) : undefined,
  spkiPins: (process.env.SPKI_PINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  auth: {
    // Panelin kokeni (CSRF Origin denetimi). Bos ise durum degistiren /api/v1 istekleri (giris dahil) reddedilir.
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    idleMinutes: process.env.SESSION_IDLE_MINUTES ? Number(process.env.SESSION_IDLE_MINUTES) : undefined,
    absoluteHours: process.env.SESSION_ABSOLUTE_HOURS ? Number(process.env.SESSION_ABSOLUTE_HOURS) : undefined,
  },
});
await app.listen({ port: Number(process.env.PORT ?? 8443), host: process.env.HOST ?? "127.0.0.1" });

// Ilk kurulum: kullanici yoksa tek kullanimlik token surec stderr'ine BIR kez yazilir (yapilandirilmis gunluge/dosyaya DEGIL).
await ensureSetupToken(pool, new Date(), (m) => process.stderr.write(m));

// Suresi dolan sifreli credential kopyalari dakikada bir silinir (yalnizca bellekte calisan zamanlayici; migrasyon gerektirmez).
const purge = setInterval(() => { void purgeExpiredCredentials(pool).catch((e) => app.log.error({ err: String(e) }, "purge hatasi")); }, 60_000);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => { clearInterval(purge); void app.close().then(() => pool.end()).then(() => process.exit(0), (e) => { console.error("kapanis hatasi:", e); process.exit(1); }); });
}

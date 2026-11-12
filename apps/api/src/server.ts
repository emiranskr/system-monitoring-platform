import { readFileSync } from "node:fs";
import { migrate } from "@sysmon/db";
import { buildApp } from "./app.js";
import { parseTrustProxy } from "./config.js";
import { purgeExpiredCredentials } from "./enrollment.js";
import { createPool } from "./pool.js";

/**
 * Yapilandirma ortam degiskenleriyle: DATABASE_URL (zorunlu), CREDENTIAL_KEY (zorunlu, 32 bayt base64: credential'larin
 * yeniden deneme penceresi boyunca sifreli tutulmasi), PORT (8443), HOST (127.0.0.1), SPKI_PINS (virgulle ayrilmis
 * sha256/<b64>), SAMPLE_INTERVAL_SECONDS (5; agent ornekleme araligi), LOG_LEVEL (info), TRUST_PROXY (kapali; ters proxy arkasinda guvenilen ATLAMA SAYISI, orn. 1, veya IP/CIDR listesi; "true" REDDEDILIR), MIGRATE ("1" = acilista migrate).
 * TLS_CERT + TLS_KEY (PEM dosya yollari) verilirse HTTPS dinler (TLS >= 1.2); verilmezse DUZ HTTP: Agent (Release) yalnizca
 * HTTPS kabul ettiginden uretimde TLS ya burada ya da onundeki ters proxy'de sonlandirilmalidir (TRUST_PROXY ile).
 */
const url = process.env.DATABASE_URL;
const key = Buffer.from(process.env.CREDENTIAL_KEY ?? "", "base64");
if (!url || key.length !== 32) {
  console.error("DATABASE_URL ve CREDENTIAL_KEY (32 bayt, base64) zorunludur.");
  process.exit(2);
}
const pool = createPool(url, (e) => console.error("DB havuz hatasi (bosta baglanti kopmasi olabilir):", e.message));
if (process.env.MIGRATE === "1") console.log("migrate:", await migrate(pool));

const app = buildApp({
  pool, credentialKey: key, logger: { level: process.env.LOG_LEVEL ?? "info" }, trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  https: process.env.TLS_CERT && process.env.TLS_KEY
    ? { cert: readFileSync(process.env.TLS_CERT), key: readFileSync(process.env.TLS_KEY) }
    : undefined,
  sampleIntervalSeconds: process.env.SAMPLE_INTERVAL_SECONDS ? Number(process.env.SAMPLE_INTERVAL_SECONDS) : undefined,
  spkiPins: (process.env.SPKI_PINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
});
await app.listen({ port: Number(process.env.PORT ?? 8443), host: process.env.HOST ?? "127.0.0.1" });

// Suresi dolan sifreli credential kopyalari dakikada bir silinir (yalnizca bellekte calisan zamanlayici; migrasyon gerektirmez).
const purge = setInterval(() => { void purgeExpiredCredentials(pool).catch((e) => app.log.error({ err: String(e) }, "purge hatasi")); }, 60_000);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => { clearInterval(purge); void app.close().then(() => pool.end()).then(() => process.exit(0), (e) => { console.error("kapanis hatasi:", e); process.exit(1); }); });
}

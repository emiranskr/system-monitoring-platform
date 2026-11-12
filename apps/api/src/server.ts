import pg from "pg";
import { migrate } from "@sysmon/db";
import { buildApp } from "./app.js";
import { purgeExpiredCredentials } from "./enrollment.js";

/**
 * Yapilandirma ortam degiskenleriyle: DATABASE_URL (zorunlu), CREDENTIAL_KEY (zorunlu, 32 bayt base64: credential'larin
 * yeniden deneme penceresi boyunca sifreli tutulmasi), PORT (8443), HOST (127.0.0.1), SPKI_PINS (virgulle ayrilmis
 * sha256/<b64>), SAMPLE_INTERVAL_SECONDS (5; agent ornekleme araligi), LOG_LEVEL (info), TRUST_PROXY ("true" = ters proxy arkasinda), MIGRATE ("1" = acilista migrate).
 * Bu surum DUZ HTTP dinler. Agent (Release) yalnizca HTTPS kabul eder; TLS M6'ya kadar ters proxy'de sonlandirilir.
 */
const url = process.env.DATABASE_URL;
const key = Buffer.from(process.env.CREDENTIAL_KEY ?? "", "base64");
if (!url || key.length !== 32) {
  console.error("DATABASE_URL ve CREDENTIAL_KEY (32 bayt, base64) zorunludur.");
  process.exit(2);
}
const pool = new pg.Pool({ connectionString: url, max: 20 });
if (process.env.MIGRATE === "1") console.log("migrate:", await migrate(pool));

const app = buildApp({
  pool, credentialKey: key, logger: { level: process.env.LOG_LEVEL ?? "info" }, trustProxy: process.env.TRUST_PROXY === "true",
  sampleIntervalSeconds: process.env.SAMPLE_INTERVAL_SECONDS ? Number(process.env.SAMPLE_INTERVAL_SECONDS) : undefined,
  spkiPins: (process.env.SPKI_PINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
});
await app.listen({ port: Number(process.env.PORT ?? 8443), host: process.env.HOST ?? "127.0.0.1" });

// Suresi dolan sifreli credential kopyalari dakikada bir silinir (yalnizca bellekte calisan zamanlayici; migrasyon gerektirmez).
const purge = setInterval(() => { void purgeExpiredCredentials(pool).catch((e) => app.log.error({ err: String(e) }, "purge hatasi")); }, 60_000);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => { clearInterval(purge); void app.close().then(() => pool.end()).then(() => process.exit(0)); });
}

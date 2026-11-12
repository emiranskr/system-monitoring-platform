import pg from "pg";
import { migrate } from "@sysmon/db";
import { buildApp } from "./app.js";

/**
 * Yapilandirma ortam degiskenleriyle: DATABASE_URL (zorunlu), PORT (8443), HOST (127.0.0.1),
 * TRUST_PROXY ("true" = ters proxy arkasinda), MIGRATE ("1" = acilista migrate).
 * Bu surum DUZ HTTP dinler. Agent (Release) yalnizca HTTPS kabul eder; TLS M6'ya kadar ters proxy'de sonlandirilir.
 */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL tanimli degil.");
  process.exit(2);
}
const pool = new pg.Pool({ connectionString: url, max: 20 });
if (process.env.MIGRATE === "1") console.log("migrate:", await migrate(pool));

const app = buildApp({ pool, logger: true, trustProxy: process.env.TRUST_PROXY === "true" });
await app.listen({ port: Number(process.env.PORT ?? 8443), host: process.env.HOST ?? "127.0.0.1" });
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => { void app.close().then(() => pool.end()).then(() => process.exit(0)); });
}

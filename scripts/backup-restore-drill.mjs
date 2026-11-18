#!/usr/bin/env node
/**
 * Yedek / geri yukleme tatbikati (YEREL, otomatik, kaynak veriye DOKUNMAZ).
 *  1) Calisan compose DB konteynerinde GECICI bir veritabani olusturulur, migrate edilir, ornek veri (hypertable + continuous aggregate dahil) basilir.
 *  2) pg_dump -Fc ile yedek alinir.
 *  3) Ayni TimescaleDB surumunde TEMIZ, gecici bir konteyner baslatilir; timescaledb_pre_restore -> pg_restore -> timescaledb_post_restore.
 *  4) Kaynak ve geri yuklenen veritabaninin tablo satir sayilari, hypertable ve continuous aggregate listeleri karsilastirilir.
 * Herhangi bir adim basarisizsa veya goruntuler uyusmazsa surec NON-ZERO cikar (basarisiz geri yukleme basarili gosterilmez).
 * Kullanim: pnpm build && node scripts/backup-restore-drill.mjs   (on kosul: deploy DB konteyneri calisiyor; DOCKER_DB_CONTAINER ile ad degistirilebilir)
 * Not: CHANNEL_KEY veritabani yedeginde YOKTUR; kanal sirlari anahtar olmadan cozulemez. Anahtari yedekten AYRI ve guvenli saklayin (docs/yedekleme.md).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compareSnapshots } from "./drill-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = process.env.DOCKER_DB_CONTAINER ?? "deploy-db-1";
const IMAGE = "timescale/timescaledb:2.17.2-pg16";
const docker = (...a) => execFileSync("docker", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
const psql = (container, db, sql) => docker("exec", container, "psql", "-U", "sysmon", "-d", db, "-v", "ON_ERROR_STOP=1", "-At", "-c", sql).trim();

function snapshot(container, db) {
  const tables = {};
  const names = psql(container, db, "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1").split("\n").filter(Boolean);
  for (const t of names) tables[t] = Number(psql(container, db, `SELECT count(*) FROM public."${t}"`));
  const list = (sql) => psql(container, db, sql).split("\n").filter(Boolean);
  return {
    tables,
    hypertables: list("SELECT hypertable_name FROM timescaledb_information.hypertables WHERE hypertable_schema = 'public' ORDER BY 1"),
    caggs: list("SELECT view_name FROM timescaledb_information.continuous_aggregates WHERE view_schema = 'public' ORDER BY 1"),
  };
}

async function main() {
  const { createTestDb } = await import(pathToFileURL(join(root, "packages/db/dist/testing.js")).href);
  const work = mkdtempSync(join(tmpdir(), "sysmon-drill-"));
  const drill = `sysmon-drill-${randomBytes(4).toString("hex")}`;
  let src; let started = false;
  try {
    docker("inspect", "-f", "{{.State.Running}}", SRC);   // kaynak konteyner calisiyor mu (yoksa hata)
    // 1) kaynak: gecici veritabani + ornek veri
    src = await createTestDb();
    const q = (sql, p = []) => src.pool.query(sql, p);
    const org = (await q("INSERT INTO orgs (name) VALUES ('tatbikat') RETURNING id")).rows[0].id;
    const dev = (await q("INSERT INTO devices (org_id, name) VALUES ($1,'drill-pc') RETURNING id", [org])).rows[0].id;
    const now = Date.now();
    await q(`INSERT INTO metric_samples (ts, org_id, device_id, metric, value)
             SELECT to_timestamp(($1::bigint - g * 60000) / 1000.0), $2, $3, m, 10 + g % 50
               FROM generate_series(0, 299) g, unnest(ARRAY['cpu.total','mem.used_pct']) m`, [now, org, dev]);
    await q("CALL refresh_continuous_aggregate('metric_1m', now() - interval '1 day', now() - interval '1 minute')");
    await q("INSERT INTO notification_channels (org_id, name, type, config_enc, summary) VALUES ($1,'k','webhook',$2,'{}')", [org, Buffer.alloc(48, 7)]);
    const srcDb = new URL(src.url).pathname.slice(1);

    // 2) yedek
    docker("exec", SRC, "pg_dump", "-U", "sysmon", "-Fc", "-f", "/tmp/drill.dump", srcDb);
    docker("cp", `${SRC}:/tmp/drill.dump`, join(work, "drill.dump"));
    docker("exec", SRC, "rm", "-f", "/tmp/drill.dump");
    const before = snapshot(SRC, srcDb);

    // 3) temiz konteynerde geri yukle
    docker("run", "-d", "--rm", "--name", drill, "-e", "POSTGRES_USER=sysmon", "-e", "POSTGRES_PASSWORD=drill-gecici", IMAGE);
    started = true;
    for (let i = 0; ; i++) {
      // Resmi imaj once GECICI bir sunucuyla ilklendirir (kapanir); ilklendirme bitip gercek sunucu acilana kadar beklenir.
      try {
        const lg = spawnSync("docker", ["logs", drill], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });   // Postgres gunlugu stderr'e yazar
        const logs = String(lg.stdout) + String(lg.stderr);
        if (logs.includes("PostgreSQL init process complete; ready for start up") && (logs.match(/ready to accept connections/g) ?? []).length >= 2 && psql(drill, "postgres", "SELECT 1") === "1") break;
      } catch { /* hazir degil */ }
      if (i > 60) throw new Error("gecici veritabani konteyneri hazir olmadi");
      await new Promise((r) => setTimeout(r, 1000));
    }
    docker("exec", drill, "createdb", "-U", "sysmon", "restored");
    docker("cp", join(work, "drill.dump"), `${drill}:/tmp/drill.dump`);
    psql(drill, "restored", "CREATE EXTENSION IF NOT EXISTS timescaledb");
    psql(drill, "restored", "SELECT timescaledb_pre_restore()");
    docker("exec", drill, "pg_restore", "-U", "sysmon", "-d", "restored", "--exit-on-error", "/tmp/drill.dump");
    psql(drill, "restored", "SELECT timescaledb_post_restore()");
    const after = snapshot(drill, "restored");

    // 4) karsilastir
    const r = compareSnapshots(before, after);
    console.log("kaynak :", JSON.stringify(before));
    console.log("geri   :", JSON.stringify(after));
    if (!r.ok) { console.error("TATBIKAT BASARISIZ:\n - " + r.problems.join("\n - ")); process.exitCode = 1; }
    else console.log("TATBIKAT BASARILI: tum tablolarin satir sayilari, hypertable ve continuous aggregate listeleri uyusuyor.");
  } catch (e) {
    console.error("TATBIKAT BASARISIZ (adim hatasi):", String(e.stderr ?? e.message ?? e).split("\n").slice(0, 8).join("\n"));
    process.exitCode = 1;
  } finally {
    if (started) { try { docker("stop", drill); } catch { /* zaten kapali */ } }
    await src?.drop().catch(() => undefined);
    rmSync(work, { recursive: true, force: true });
  }
}
await main();

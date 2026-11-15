import { copyFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrate } from "../src/index.js";
import { createTestDb, type TestDb } from "../src/testing.js";

/**
 * Inceleme I-5: 0003 hic DOLU ve KISMEN SIKISTIRILMIS bir 0001/0002 durumunun ustune uygulanmamisti.
 * Burada 0001+0002 uygulanir, veri eklenir ve bir chunk sikistirilir; sonra 0003 uygulanir.
 */
let db: TestDb, tmp: string;
let dev = "", org = "";

beforeAll(async () => {
  db = await createTestDb({ migrate: false });
  tmp = mkdtempSync(join(tmpdir(), "sysmon-mig-"));
  mkdirSync(tmp, { recursive: true });
  for (const f of ["0001_init.sql", "0002_enrollment_rotation.sql"]) copyFileSync(join(MIGRATIONS_DIR, f), join(tmp, f));
  expect(await migrate(db.pool, tmp)).toEqual(["0001_init.sql", "0002_enrollment_rotation.sql"]);

  org = (await db.pool.query("INSERT INTO orgs (name) VALUES ('up') RETURNING id")).rows[0].id;
  dev = (await db.pool.query("INSERT INTO devices (org_id, name) VALUES ($1,'up') RETURNING id", [org])).rows[0].id;
  await db.pool.query(
    `INSERT INTO metric_samples (ts, org_id, device_id, metric, value)
     SELECT t, $1, $2, 'cpu.total', extract(epoch from t)::int % 100
       FROM generate_series(now() - interval '30 hours', now() - interval '29 hours', interval '1 second') t`, [org, dev]);
  // Veriyi iceren (1 gunluk) chunk'in BITISI "20 saat once"ten yeni olabilir: filtre kullanma, mevcut tum chunk'lari sikistir.
  for (const c of (await db.pool.query("SELECT show_chunks('metric_samples') c")).rows) {
    // Arka plandaki sikistirma isiyle yaris: "already compressed" yutulur (bkz. schema.test.ts).
    try { await db.pool.query("SELECT compress_chunk($1::regclass, if_not_compressed => true)", [c.c]); }
    catch (e) { if (!/already compressed/.test((e as Error).message)) throw e; }
  }
}, 180_000);

afterAll(async () => {
  await db?.drop();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("0003 doluluk ve kismi siksistirma uzerinde yukseltme", () => {
  it("0003 uygulanir, mevcut (sikistirilmis) veri okunabilir kalir, yeni veri yazilabilir", async () => {
    const before = Number((await db.pool.query("SELECT count(*) FROM metric_samples")).rows[0].count);
    const cmpBefore = Number((await db.pool.query("SELECT count(*)::int n FROM timescaledb_information.chunks WHERE hypertable_name='metric_samples' AND is_compressed")).rows[0].n);
    expect(cmpBefore).toBeGreaterThan(0);

    // 0003 ve ondan sonraki TUM migration'lar uygulanir (yeni migration eklenince bu test kirilmasin).
    const applied = await migrate(db.pool);
    expect(applied[0]).toBe("0003_storage_tuning.sql");

    expect(Number((await db.pool.query("SELECT count(*) FROM metric_samples")).rows[0].count)).toBe(before); // veri kaybi yok
    // Sikistirilmis eski chunk'a (a) GERCEK yinelenen ve (b) yeni satir. Zaman damgasi SQL icinde alinir: JS Date mikrosaniyeyi
    // ms'ye keserdi ve "yinelenen" aslinda yeni bir satir olurdu.
    const conflict = "ON CONFLICT (device_id, metric, ts) DO NOTHING";
    await db.pool.query(`INSERT INTO metric_samples SELECT min(ts), org_id, device_id, metric, 999 FROM metric_samples GROUP BY org_id, device_id, metric ${conflict}`);
    await db.pool.query(`INSERT INTO metric_samples SELECT max(ts) + interval '500 milliseconds', org_id, device_id, metric, 7 FROM metric_samples GROUP BY org_id, device_id, metric ${conflict}`);
    expect(Number((await db.pool.query("SELECT count(*) FROM metric_samples")).rows[0].count)).toBe(before + 1); // yalniz yeni satir
    expect(Number((await db.pool.query("SELECT count(*) FROM metric_samples WHERE value = 999")).rows[0].count)).toBe(0); // yinelenen atlandi
  });

  it("politikalar yenilendi: eski sikistirma politikasi kalmadi, yenisi 12 saat; agrega sikistirma acik", async () => {
    const jobs = (await db.pool.query(
      "SELECT config FROM timescaledb_information.jobs WHERE proc_name='policy_compression' AND hypertable_name='metric_samples'")).rows;
    expect(jobs).toHaveLength(1);                               // bir tane: eskisi kaldirildi
    expect(jobs[0].config.compress_after).toBe("12:00:00");
    const cagg = (await db.pool.query("SELECT compression_enabled FROM timescaledb_information.continuous_aggregates WHERE view_name='metric_1m'")).rows[0];
    expect(cagg.compression_enabled).toBe(true);
  });

  it("YENI chunk'lar 6 saatlik; mevcut chunk'lar oldugu gibi kalir", async () => {
    await db.pool.query("INSERT INTO metric_samples (ts, org_id, device_id, metric, value) VALUES (now(), $1, $2, 'cpu.total', 1)", [org, dev]);
    const newest = (await db.pool.query(
      "SELECT extract(epoch from (range_end - range_start))/3600 AS h FROM timescaledb_information.chunks WHERE hypertable_name='metric_samples' ORDER BY range_start DESC LIMIT 1")).rows[0];
    expect(Number(newest.h)).toBe(6);
    const oldest = (await db.pool.query(
      "SELECT extract(epoch from (range_end - range_start))/3600 AS h FROM timescaledb_information.chunks WHERE hypertable_name='metric_samples' ORDER BY range_start ASC LIMIT 1")).rows[0];
    expect(Number(oldest.h)).toBe(24); // 0001'in 1 gunluk chunk'i degismedi
  });

  it("yeniden calistirmak zararsizdir", async () => {
    expect(await migrate(db.pool)).toEqual([]);
  });
});

import { copyFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrate } from "../src/index.js";
import { createTestDb, type TestDb } from "../src/testing.js";

/**
 * Yukseltme yolu (M6): 0001..0005 UYGULANMIS ve VERI DOLU bir veritabanina 0006 (saklama indeksleri) uygulanir.
 * Beklenti: yalniz 0006 uygulanir, mevcut veri aynen kalir, indeksler olusur; tekrar calistirmak bir sey uygulamaz.
 * (0005 ve oncekiler M5 sonrasi DEGISMEDI; 0006 yeni ve yalniz indeks ekler: veri/sema degistirmez.)
 */
let db: TestDb, tmp: string;
const OLD = ["0001_init.sql", "0002_enrollment_rotation.sql", "0003_storage_tuning.sql", "0004_users_sessions.sql", "0005_alerts.sql"];

beforeAll(async () => {
  db = await createTestDb({ migrate: false });
  tmp = mkdtempSync(join(tmpdir(), "sysmon-mig6-"));
  mkdirSync(tmp, { recursive: true });
  for (const f of OLD) copyFileSync(join(MIGRATIONS_DIR, f), join(tmp, f));
  expect(await migrate(db.pool, tmp)).toEqual(OLD);
}, 180_000);
afterAll(async () => { await db?.drop(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

describe("0005 -> 0006 yukseltme", () => {
  it("veri doluyken yalniz 0006 uygulanir; veri korunur; indeksler olusur; ikinci calistirma bos", async () => {
    const q = (s: string, p: unknown[] = []) => db.pool.query(s, p);
    const org = (await q("INSERT INTO orgs (name) VALUES ('yuk') RETURNING id")).rows[0].id;
    const dev = (await q("INSERT INTO devices (org_id, name) VALUES ($1,'pc') RETURNING id", [org])).rows[0].id;
    const ch = (await q("INSERT INTO notification_channels (org_id, name, type, config_enc, summary) VALUES ($1,'k','webhook',$2,'{}') RETURNING id", [org, Buffer.alloc(40, 3)])).rows[0].id;
    const rl = (await q("INSERT INTO alert_rules (org_id, name, metric, agg, window_seconds, operator, threshold, for_seconds, severity) VALUES ($1,'r','cpu.total','avg',60,'>',90,0,'warning') RETURNING id", [org])).rows[0].id;
    const inc = (await q("INSERT INTO incidents (org_id, rule_id, device_id, rule_name, device_name, metric, severity, opened_at, resolved_at) VALUES ($1,$2,$3,'r','pc','cpu.total','warning', now(), now()) RETURNING id", [org, rl, dev])).rows[0].id;
    await q("INSERT INTO notifications (org_id, incident_id, channel_id, kind, status, next_attempt_at, payload, sent_at) VALUES ($1,$2,$3,'firing','sent', now(), '{}', now())", [org, inc, ch]);

    expect(await migrate(db.pool)).toEqual(["0006_alert_retention_indexes.sql"]);

    for (const [t, n] of [["orgs", 1], ["devices", 1], ["notification_channels", 1], ["alert_rules", 1], ["incidents", 1], ["notifications", 1]] as const) {
      expect((await q(`SELECT count(*)::int AS c FROM ${t}`)).rows[0].c, t).toBe(n);
    }
    const idx = (await q("SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('notifications_rate_idx','notifications_purge_idx','incidents_resolved_idx') ORDER BY 1")).rows.map((r) => r.indexname);
    expect(idx).toEqual(["incidents_resolved_idx", "notifications_purge_idx", "notifications_rate_idx"]);
    expect(await migrate(db.pool)).toEqual([]);
  });
});

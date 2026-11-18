import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { purgeAlertData } from "../src/alerts/retention.js";
import { setupKit, type Kit } from "./kit.js";

let k: Kit;
const q = (sql: string, p: unknown[] = []) => k.db.pool.query(sql, p);
const NOW = new Date("2026-11-18T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
let dev = "", ch = "", rl = "";

beforeAll(async () => { k = await setupKit(); }, 120_000);
afterAll(async () => { await k?.close(); });
beforeEach(async () => {
  for (const t of ["notifications", "incidents", "alert_state", "alert_rules", "notification_channels", "devices"]) await q(`DELETE FROM ${t}`);
  dev = (await q("INSERT INTO devices (org_id, name) VALUES ($1,'pc') RETURNING id", [k.org])).rows[0].id;
  ch = (await q("INSERT INTO notification_channels (org_id, name, type, config_enc, summary) VALUES ($1,'c','webhook',$2,'{}') RETURNING id", [k.org, Buffer.alloc(40, 1)])).rows[0].id;
  rl = (await q("INSERT INTO alert_rules (org_id, name, metric, agg, window_seconds, operator, threshold, for_seconds, severity) VALUES ($1,'r','cpu.total','avg',60,'>',90,0,'warning') RETURNING id", [k.org])).rows[0].id;
});

async function incident(openedDaysAgo: number, resolvedDaysAgo: number | null) {
  return (await q(
    `INSERT INTO incidents (org_id, rule_id, device_id, rule_name, device_name, metric, severity, opened_at, resolved_at) VALUES ($1,$2,$3,'r','pc','cpu.total','warning',$4,$5) RETURNING id`,
    [k.org, rl, dev, daysAgo(openedDaysAgo), resolvedDaysAgo === null ? null : daysAgo(resolvedDaysAgo)])).rows[0].id as string;
}
async function notif(incidentId: string | null, kind: string, status: string, createdDaysAgo: number) {
  return (await q(
    `INSERT INTO notifications (org_id, incident_id, channel_id, kind, status, next_attempt_at, payload, created_at, sent_at) VALUES ($1,$2,$3,$4,$5,$6,'{}',$6,$7) RETURNING id`,
    [k.org, incidentId, ch, kind, status, daysAgo(createdDaysAgo), status === "sent" ? daysAgo(createdDaysAgo) : null])).rows[0].id as string;
}
const count = async (t: string) => (await q(`SELECT count(*)::int AS c FROM ${t}`)).rows[0].c as number;

describe("saklama suresi (veri butunlugu): yalniz ESKI ve BITMIS veri silinir", () => {
  it("eski sent/failed bildirimler silinir; yeni olanlar, bekleyen ve gonderilmekte olanlar KALIR (bildirim 30 gun)", async () => {
    const i = await incident(1, null);
    await notif(i, "firing", "sent", 40);          // eski + bitmis -> silinir
    await notif(i, "resolved", "failed", 31);      // eski + bitmis -> silinir
    await notif(null, "test", "sent", 35);         // eski test -> silinir
    await notif(null, "test", "sent", 29);         // yeni -> kalir
    await q(`INSERT INTO notifications (org_id, incident_id, channel_id, kind, status, next_attempt_at, payload, created_at) VALUES ($1,NULL,$2,'test','pending',$3,'{}',$3)`, [k.org, ch, daysAgo(60)]);   // 60 gunluk ama BEKLEYEN -> kalir
    const r = await purgeAlertData(k.db.pool, NOW);
    expect(r.notifications).toBe(3);
    expect(await count("notifications")).toBe(2);
    expect(await count("incidents")).toBe(1);       // bildirim temizligi olayi etkilemez
  });

  it("olay gecmisi: 180 gunden eski COZULMUS olaylar (ve bildirimleri) silinir; yeni cozulmus ve ACIK olaylar (eski olsa bile) KALIR", async () => {
    const oldResolved = await incident(400, 200);
    await notif(oldResolved, "firing", "sent", 399);
    const recentResolved = await incident(50, 40);
    const oldOpen = await incident(500, null);      // hala acik: ASLA silinmez
    const r = await purgeAlertData(k.db.pool, NOW);
    expect(r.incidents).toBe(1);
    const ids = (await q("SELECT id FROM incidents")).rows.map((x) => x.id).sort();
    expect(ids).toEqual([recentResolved, oldOpen].sort());
    expect(await count("notifications")).toBe(0);   // silinen olayin bildirimi de gitti (FK ihlali yok)
  });

  it("bekleyen bildirimi olan eski cozulmus olay SILINMEZ (teslimat kaybolmasin)", async () => {
    const i = await incident(400, 200);
    await q(`INSERT INTO notifications (org_id, incident_id, channel_id, kind, status, next_attempt_at, payload) VALUES ($1,$2,$3,'resolved','pending',$4,'{}')`, [k.org, i, ch, NOW]);
    const r = await purgeAlertData(k.db.pool, NOW);
    expect(r.incidents).toBe(0);
    expect(await count("incidents")).toBe(1);
    expect(await count("notifications")).toBe(1);
  });

  it("kural/kanal silme (yumusak) olay gecmisini YOK ETMEZ; temizlik yalniz yasa bakar", async () => {
    const i = await incident(5, 4);
    await q("UPDATE alert_rules SET deleted_at = $1, enabled = false WHERE id = $2", [NOW, rl]);
    await q("UPDATE notification_channels SET deleted_at = $1 WHERE id = $2", [NOW, ch]);
    await purgeAlertData(k.db.pool, NOW);
    expect((await q("SELECT id FROM incidents")).rows.map((x) => x.id)).toEqual([i]);
  });

  it("ozel sure: 0 veya negatif gun REDDEDILIR (yanlislikla tum gecmis silinmesin)", async () => {
    await incident(400, 200);
    await expect(purgeAlertData(k.db.pool, NOW, { incidentDays: 0 })).rejects.toThrow();
    await expect(purgeAlertData(k.db.pool, NOW, { notificationDays: -1 })).rejects.toThrow();
    expect(await count("incidents")).toBe(1);
  });
});

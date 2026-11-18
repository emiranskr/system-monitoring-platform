import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../src/testing.js";

let db: TestDb;
let orgA: string, orgB: string, devA: string, devB: string, ruleA: string, ruleB: string, chA: string, chB: string;
const q = (sql: string, p: unknown[] = []) => db.pool.query(sql, p);

const rule = (org: string, name = "r") =>
  q(`INSERT INTO alert_rules (org_id, name, metric, agg, window_seconds, operator, threshold, for_seconds, severity)
     VALUES ($1,$2,'cpu.total','avg',60,'>',90,120,'warning') RETURNING id`, [org, name]).then((r) => r.rows[0].id as string);
const channel = (org: string) =>
  q("INSERT INTO notification_channels (org_id, name, type, config_enc, summary) VALUES ($1,'c','webhook',$2,'{}') RETURNING id", [org, Buffer.alloc(40, 1)]).then((r) => r.rows[0].id as string);
const incident = (org: string, rid: string, dev: string) =>
  q("INSERT INTO incidents (org_id, rule_id, device_id, rule_name, device_name, metric, severity, opened_at) VALUES ($1,$2,$3,'r','d','cpu.total','warning', now()) RETURNING id", [org, rid, dev]);

beforeAll(async () => {
  db = await createTestDb();
  orgA = (await q("INSERT INTO orgs (name) VALUES ('A') RETURNING id")).rows[0].id;
  orgB = (await q("INSERT INTO orgs (name) VALUES ('B') RETURNING id")).rows[0].id;
  devA = (await q("INSERT INTO devices (org_id, name) VALUES ($1,'a1') RETURNING id", [orgA])).rows[0].id;
  devB = (await q("INSERT INTO devices (org_id, name) VALUES ($1,'b1') RETURNING id", [orgB])).rows[0].id;
  ruleA = await rule(orgA);
  ruleB = await rule(orgB);
  chA = await channel(orgA);
  chB = await channel(orgB);
}, 120_000);

afterAll(async () => { await db?.drop(); });

describe("M5 uyari semasi", () => {
  it("izin disi operator, agg, onem ve pencere CHECK ile reddedilir", async () => {
    const bad = (over: string) => q(`INSERT INTO alert_rules (org_id,name,metric,agg,window_seconds,operator,threshold,for_seconds,severity) VALUES ($1,'x',${over})`, [orgA]);
    await expect(bad("'cpu.total','avg',60,'; DROP TABLE x;--',1,0,'info'")).rejects.toThrow();
    await expect(bad("'cpu.total','median',60,'>',1,0,'info'")).rejects.toThrow();
    await expect(bad("'cpu.total','avg',60,'>',1,0,'urgent'")).rejects.toThrow();
    await expect(bad("'cpu.total','avg',5,'>',1,0,'info'")).rejects.toThrow();
    await expect(bad("'cpu.total','avg',60,'>',1,-1,'info'")).rejects.toThrow();
  });

  it("baska organizasyonun kural/cihazina olay baglanamaz (bilesik FK)", async () => {
    await expect(incident(orgA, ruleB, devA)).rejects.toThrow();
    await expect(incident(orgA, ruleA, devB)).rejects.toThrow();
    await incident(orgA, ruleA, devA); // dogru eslesme calisir
  });

  it("ayni kural/cihaz icin ikinci ACIK olay olusamaz; cozulunce yenisi olusabilir", async () => {
    const r2 = await rule(orgA, "r2");
    const first = (await incident(orgA, r2, devA)).rows[0].id;
    await expect(incident(orgA, r2, devA)).rejects.toThrow();
    await q("UPDATE incidents SET resolved_at = now() WHERE id = $1", [first]);
    await incident(orgA, r2, devA);
  });

  it("bildirim: baska organizasyonun kanalina baglanamaz; ayni olay+tur+kanal icin ikinci satir olusamaz (mukerrer yok)", async () => {
    const r3 = await rule(orgA, "r3");
    const inc = (await incident(orgA, r3, devA)).rows[0].id;
    const ins = (org: string, ch: string, kind = "firing") =>
      q("INSERT INTO notifications (org_id, incident_id, channel_id, kind, status, next_attempt_at, payload) VALUES ($1,$2,$3,$4,'pending', now(), '{}')", [org, inc, ch, kind]);
    await expect(ins(orgA, chB)).rejects.toThrow();            // org uyusmazligi
    await ins(orgA, chA);
    await expect(ins(orgA, chA)).rejects.toThrow();            // mukerrer
    await ins(orgA, chA, "resolved");                          // farkli tur serbest
  });

  it("yerlesik kural organizasyon basina bir kez (silinmemis)", async () => {
    await q("INSERT INTO alert_rules (org_id,name,metric,agg,window_seconds,operator,threshold,for_seconds,severity,builtin) VALUES ($1,'o','device.offline','max',60,'>',60,0,'critical','offline')", [orgB]);
    await expect(q("INSERT INTO alert_rules (org_id,name,metric,agg,window_seconds,operator,threshold,for_seconds,severity,builtin) VALUES ($1,'o2','device.offline','max',60,'>',60,0,'critical','offline')", [orgB])).rejects.toThrow();
    await q("INSERT INTO alert_rules (org_id,name,metric,agg,window_seconds,operator,threshold,for_seconds,severity,builtin) VALUES ($1,'o','device.offline','max',60,'>',60,0,'critical','offline')", [orgA]); // baska org serbest
  });
});

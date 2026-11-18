import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { evaluateAlerts, ALERT_LOCK_KEY } from "../src/alerts/evaluator.js";
import { setupKit, type Kit } from "./kit.js";

let k: Kit;
let orgB: string;
const T0 = new Date("2026-11-18T12:00:00Z");
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);
const q = (sql: string, p: unknown[] = []) => k.db.pool.query(sql, p);
const STARTED = new Date("2026-11-18T10:00:00Z"); // sunucu 2 saat once acildi: acilis grace'i bitmis
const ctx = (over: Partial<{ startedAt: Date; ingestHealthy: boolean }> = {}) => ({ startedAt: STARTED, ingestHealthy: true, ...over });

async function device(org: string, name: string, lastSeen: Date | null = at(0)) {
  return (await q("INSERT INTO devices (org_id, name, last_seen_at) VALUES ($1,$2,$3) RETURNING id", [org, name, lastSeen])).rows[0].id as string;
}
async function sample(org: string, dev: string, metric: string, value: number | null, sec: number) {
  await q("INSERT INTO metric_samples (ts, org_id, device_id, metric, value) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [at(sec), org, dev, metric, value]);
}
async function channel(org: string) {
  return (await q("INSERT INTO notification_channels (org_id, name, type, config_enc, summary) VALUES ($1,'c','webhook',$2,'{}') RETURNING id", [org, Buffer.alloc(40, 1)])).rows[0].id as string;
}
async function rule(org: string, over: Record<string, unknown> = {}) {
  const r = { name: "cpu yuksek", metric: "cpu.total", agg: "avg", window_seconds: 60, operator: ">", threshold: 90, hysteresis: 0, for_seconds: 60, severity: "warning", scope_device_ids: null, channel_ids: [] as string[], enabled: true, ...over };
  return (await q(
    `INSERT INTO alert_rules (org_id, name, metric, agg, window_seconds, operator, threshold, hysteresis, for_seconds, severity, scope_device_ids, channel_ids, enabled)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [org, r.name, r.metric, r.agg, r.window_seconds, r.operator, r.threshold, r.hysteresis, r.for_seconds, r.severity, r.scope_device_ids, r.channel_ids, r.enabled])).rows[0].id as string;
}
const incidents = async (ruleId: string) => (await q("SELECT * FROM incidents WHERE rule_id = $1 ORDER BY opened_at", [ruleId])).rows;
const notifs = async (ruleId: string) => (await q("SELECT n.* FROM notifications n JOIN incidents i ON i.id = n.incident_id WHERE i.rule_id = $1 ORDER BY n.created_at, n.kind", [ruleId])).rows;
const state = async (ruleId: string, dev: string) => (await q("SELECT state FROM alert_state WHERE rule_id=$1 AND device_id=$2", [ruleId, dev])).rows[0]?.state as string | undefined;

beforeAll(async () => {
  k = await setupKit();
  orgB = (await q("INSERT INTO orgs (name) VALUES ('B') RETURNING id")).rows[0].id;
}, 120_000);
afterAll(async () => { await k?.close(); });
beforeEach(async () => {
  await q("DELETE FROM notifications");
  await q("DELETE FROM incidents");
  await q("DELETE FROM alert_state");
  await q("DELETE FROM alert_rules");
  await q("DELETE FROM metric_samples");
  await q("DELETE FROM notification_channels");
  await q("DELETE FROM devices");
});

describe("degerlendirici: metrik kurali", () => {
  it("ihlal -> PENDING (olay yok) -> for dolunca FIRING (olay + bildirim) -> cozulunce RESOLVED (olay kapanir + cozuldu bildirimi)", async () => {
    const d = await device(k.org, "pc1");
    const ch = await channel(k.org);
    const r = await rule(k.org, { channel_ids: [ch] });

    await sample(k.org, d, "cpu.total", 95, -10);
    await evaluateAlerts(k.db.pool, at(0), ctx());
    expect(await state(r, d)).toBe("pending");
    expect(await incidents(r)).toHaveLength(0);

    await sample(k.org, d, "cpu.total", 96, 50);
    await evaluateAlerts(k.db.pool, at(59), ctx());
    expect(await incidents(r)).toHaveLength(0);                       // 59 sn: for henuz dolmadi

    await sample(k.org, d, "cpu.total", 97, 60);
    const f = await evaluateAlerts(k.db.pool, at(60), ctx());
    expect(f.fired).toBeGreaterThanOrEqual(1);
    const inc = await incidents(r);
    expect(inc).toHaveLength(1);
    expect(inc[0].resolved_at).toBeNull();
    expect(inc[0].rule_name).toBe("cpu yuksek");
    expect(inc[0].device_name).toBe("pc1");
    const n = await notifs(r);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ kind: "firing", status: "pending", channel_id: ch });
    expect(n[0].payload).toMatchObject({ kind: "firing", severity: "warning", rule_name: "cpu yuksek", device_name: "pc1", metric: "cpu.total" });

    await sample(k.org, d, "cpu.total", 20, 130);
    await sample(k.org, d, "cpu.total", 25, 140);
    await evaluateAlerts(k.db.pool, at(150), ctx());                  // pencere (son 60 sn) dusuk
    const inc2 = await incidents(r);
    expect(inc2[0].resolved_at).not.toBeNull();
    expect((await notifs(r)).map((x) => x.kind).sort()).toEqual(["firing", "resolved"]);
  });

  it("ayni anda iki kez degerlendirmek MUKERRER olay/bildirim uretmez", async () => {
    const d = await device(k.org, "pc1");
    const ch = await channel(k.org);
    const r = await rule(k.org, { channel_ids: [ch], for_seconds: 0 });
    await sample(k.org, d, "cpu.total", 99, -5);
    await evaluateAlerts(k.db.pool, at(0), ctx());
    await evaluateAlerts(k.db.pool, at(0), ctx());
    await evaluateAlerts(k.db.pool, at(15), ctx());
    expect(await incidents(r)).toHaveLength(1);
    expect(await notifs(r)).toHaveLength(1);
  });

  it("veri yok (pencerede ornek yok): durum degismez, cozulmez", async () => {
    const d = await device(k.org, "pc1");
    const r = await rule(k.org, { for_seconds: 0 });
    await sample(k.org, d, "cpu.total", 99, -5);
    await evaluateAlerts(k.db.pool, at(0), ctx());
    expect(await state(r, d)).toBe("firing");
    await evaluateAlerts(k.db.pool, at(300), ctx());                  // pencere bos
    expect(await state(r, d)).toBe("firing");
    expect((await incidents(r))[0].resolved_at).toBeNull();
  });

  it("ORG IZOLASYONU: kural yalniz kendi organizasyonunun cihazlarini degerlendirir", async () => {
    const dA = await device(k.org, "a");
    const dB = await device(orgB, "b");
    const r = await rule(k.org, { for_seconds: 0 });
    await sample(k.org, dA, "cpu.total", 99, -5);
    await sample(orgB, dB, "cpu.total", 99, -5);
    await evaluateAlerts(k.db.pool, at(0), ctx());
    const inc = await incidents(r);
    expect(inc.map((x) => x.device_id)).toEqual([dA]);
    expect(await state(r, dB)).toBeUndefined();
  });

  it("kapsam listesi: yalniz listelenen cihazlar", async () => {
    const d1 = await device(k.org, "d1");
    const d2 = await device(k.org, "d2");
    const r = await rule(k.org, { for_seconds: 0, scope_device_ids: [d1] });
    await sample(k.org, d1, "cpu.total", 99, -5);
    await sample(k.org, d2, "cpu.total", 99, -5);
    await evaluateAlerts(k.db.pool, at(0), ctx());
    expect((await incidents(r)).map((x) => x.device_id)).toEqual([d1]);
  });

  it("joker disk.*.used_pct: herhangi bir diskte ihlal (max) yeterlidir; LIKE kalibi _ ve % kacirir", async () => {
    const d = await device(k.org, "pc");
    const r = await rule(k.org, { metric: "disk.*.used_pct", agg: "max", threshold: 90, for_seconds: 0 });
    await sample(k.org, d, "disk.c.used_pct", 40, -5);
    await sample(k.org, d, "disk.d.used_pct", 95, -5);
    await sample(k.org, d, "diskXc.used_pct", 99, -5);               // joker deseniyle ESLESMEMELI (nokta degil 'X')
    await evaluateAlerts(k.db.pool, at(0), ctx());
    expect(await incidents(r)).toHaveLength(1);

    const d2 = await device(k.org, "pc2");
    await sample(k.org, d2, "disk.c.used_pct", 40, -5);
    await sample(k.org, d2, "diskXc.used_pct", 99, -5);
    await evaluateAlerts(k.db.pool, at(15), ctx());
    expect((await incidents(r)).filter((x) => x.device_id === d2)).toHaveLength(0);
  });

  it("izin listesi disi/enjekte metrik ADI olan kural (DB'ye dogrudan yazilmis) atlanir, hata vermez, olay uretmez", async () => {
    const d = await device(k.org, "pc");
    await sample(k.org, d, "cpu.total", 99, -5);
    await sample(k.org, d, "evil.metric", 99, -5);                    // izin listesi disi ama VERISI olan metrik
    const r = await rule(k.org, { metric: "cpu.total' OR '1'='1", for_seconds: 0 });
    const r2 = await rule(k.org, { name: "evil", metric: "evil.metric", for_seconds: 0 });
    const res = await evaluateAlerts(k.db.pool, at(0), ctx());
    expect(res.ran).toBe(true);
    expect(await incidents(r)).toHaveLength(0);
    expect(await incidents(r2)).toHaveLength(0);                      // izin listesi ikinci savunma: veri olsa bile degerlendirilmez
    expect((await q("SELECT count(*)::int AS n FROM metric_samples")).rows[0].n).toBe(2); // tablo saglam (2 ornek)
  });

  it("devre disi/silinen kural: acik olaylar SESSIZCE kapanir (bildirim uretilmez), durum temizlenir", async () => {
    const d = await device(k.org, "pc");
    const ch = await channel(k.org);
    const r = await rule(k.org, { channel_ids: [ch], for_seconds: 0 });
    await sample(k.org, d, "cpu.total", 99, -5);
    await evaluateAlerts(k.db.pool, at(0), ctx());
    expect((await incidents(r))[0].resolved_at).toBeNull();
    await q("UPDATE alert_rules SET enabled = false WHERE id = $1", [r]);
    await evaluateAlerts(k.db.pool, at(15), ctx());
    expect((await incidents(r))[0].resolved_at).not.toBeNull();
    expect(await state(r, d)).toBeUndefined();
    expect((await notifs(r)).map((x) => x.kind)).toEqual(["firing"]);   // cozuldu bildirimi yok
  });

  it("iptal edilmis (revoked) cihaz degerlendirilmez ve acik olayi kapanir", async () => {
    const d = await device(k.org, "pc");
    const r = await rule(k.org, { for_seconds: 0 });
    await sample(k.org, d, "cpu.total", 99, -5);
    await evaluateAlerts(k.db.pool, at(0), ctx());
    await q("UPDATE devices SET revoked_at = $2 WHERE id = $1", [d, at(5)]);
    await evaluateAlerts(k.db.pool, at(15), ctx());
    expect((await incidents(r))[0].resolved_at).not.toBeNull();
  });

  it("silinmis kanal bildirim uretmez; baska organizasyonun kanali kural kanal listesinde olsa bile bildirim OLUSMAZ", async () => {
    const d = await device(k.org, "pc");
    const chB = await channel(orgB);
    const r = await rule(k.org, { channel_ids: [chB], for_seconds: 0 });
    await sample(k.org, d, "cpu.total", 99, -5);
    await evaluateAlerts(k.db.pool, at(0), ctx());
    expect(await incidents(r)).toHaveLength(1);
    expect(await notifs(r)).toHaveLength(0);
    expect((await q("SELECT count(*)::int AS n FROM notifications WHERE org_id = $1", [orgB])).rows[0].n).toBe(0);
  });

  it("silinmis (yumusak) kanala bildirim uretilmez", async () => {
    const d = await device(k.org, "pc");
    const ch = await channel(k.org);
    await q("UPDATE notification_channels SET deleted_at = now() WHERE id = $1", [ch]);
    const r = await rule(k.org, { channel_ids: [ch], for_seconds: 0 });
    await sample(k.org, d, "cpu.total", 99, -5);
    await evaluateAlerts(k.db.pool, at(0), ctx());
    expect(await incidents(r)).toHaveLength(1);
    expect(await notifs(r)).toHaveLength(0);
  });

  it("es zamanli degerlendirici engellenir: advisory kilit baska oturumda tutuluyorsa ran=false", async () => {
    const holder = await k.db.pool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock($1)", [ALERT_LOCK_KEY]);
      const res = await evaluateAlerts(k.db.pool, at(0), ctx());
      expect(res).toEqual({ ran: false, fired: 0, resolved: 0 });
    } finally {
      await holder.query("SELECT pg_advisory_unlock($1)", [ALERT_LOCK_KEY]);
      holder.release();
    }
    expect((await evaluateAlerts(k.db.pool, at(0), ctx())).ran).toBe(true);
  });
});

describe("degerlendirici: cevrimdisi tespiti (sunucu alim zamani, grace, ingest devre kesici)", () => {
  const offlineRule = async () => (await q("SELECT id FROM alert_rules WHERE org_id=$1 AND builtin='offline'", [k.org])).rows[0].id as string;

  it("yerlesik kurallar her organizasyon icin olusur (4 adet) ve tekrar calistirmak cogaltmaz", async () => {
    await evaluateAlerts(k.db.pool, at(0), ctx());
    await evaluateAlerts(k.db.pool, at(15), ctx());
    const b = (await q("SELECT builtin FROM alert_rules WHERE org_id=$1 AND builtin IS NOT NULL ORDER BY builtin", [k.org])).rows.map((x) => x.builtin);
    expect(b).toEqual(["cpu_high", "disk_full", "mem_high", "offline"]);
  });

  it("60 sn esigi asilsa da 300 sn (backoff tavani) dolmadan alarm YOK; dolunca cevrimdisi olayi", async () => {
    const d = await device(k.org, "pc", at(-100));                    // 100 sn once goruldu
    await evaluateAlerts(k.db.pool, at(0), ctx());
    const r = await offlineRule();
    expect(await state(r, d)).toBe("pending");
    await evaluateAlerts(k.db.pool, at(299), ctx());
    expect(await incidents(r)).toHaveLength(0);
    await evaluateAlerts(k.db.pool, at(300), ctx());
    expect(await incidents(r)).toHaveLength(1);
  });

  it("cihaz geri gelince (last_seen guncel) olay cozulur; kisa kopma (<60 sn) hic PENDING olmaz", async () => {
    const d = await device(k.org, "pc", at(-30));                     // 30 sn: esik altinda
    await evaluateAlerts(k.db.pool, at(0), ctx());
    const r = await offlineRule();
    expect(await state(r, d)).toBeUndefined();                        // ok durumu satiri bile yok/ok
    await q("UPDATE devices SET last_seen_at = $2 WHERE id = $1", [d, at(-200)]);
    await evaluateAlerts(k.db.pool, at(0), ctx());
    await evaluateAlerts(k.db.pool, at(300), ctx());
    expect(await incidents(r)).toHaveLength(1);
    await q("UPDATE devices SET last_seen_at = $2 WHERE id = $1", [d, at(310)]);   // geri geldi
    await evaluateAlerts(k.db.pool, at(315), ctx());
    expect((await incidents(r))[0].resolved_at).not.toBeNull();
  });

  it("hic gorulmemis (last_seen_at NULL) cihaz icin cevrimdisi alarmi uretilmez", async () => {
    const d = await device(k.org, "yeni", null);
    await evaluateAlerts(k.db.pool, at(0), ctx());
    await evaluateAlerts(k.db.pool, at(1000), ctx());
    expect(await incidents(await offlineRule())).toHaveLength(0);
    expect(await state(await offlineRule(), d)).toBeUndefined();
  });

  it("sunucu acilisindan sonra grace (6 dk) boyunca cevrimdisi alarmi yok; PENDING bile olusmaz", async () => {
    const d = await device(k.org, "pc", at(-1000));
    const startedAt = at(-60);                                        // 1 dk once acildi
    await evaluateAlerts(k.db.pool, at(0), ctx({ startedAt }));
    const r = await offlineRule();
    expect(await state(r, d)).toBeUndefined();
    await evaluateAlerts(k.db.pool, at(-60 + 359), ctx({ startedAt }));
    expect(await state(r, d)).toBeUndefined();
    await evaluateAlerts(k.db.pool, at(-60 + 360), ctx({ startedAt })); // grace bitti: PENDING baslar
    expect(await state(r, d)).toBe("pending");
  });

  it("INGEST SAGLIKSIZKEN cevrimdisi alarmi bastirilir ve bekleyen PENDING sifirlanir (kurtarma sonrasi hemen alarm olmaz)", async () => {
    const d = await device(k.org, "pc", at(-1000));
    await evaluateAlerts(k.db.pool, at(0), ctx());
    const r = await offlineRule();
    expect(await state(r, d)).toBe("pending");
    await evaluateAlerts(k.db.pool, at(100), ctx({ ingestHealthy: false }));
    expect(await state(r, d)).toBe("ok");                             // sifirlandi
    await evaluateAlerts(k.db.pool, at(400), ctx({ ingestHealthy: false }));
    expect(await incidents(r)).toHaveLength(0);
    await evaluateAlerts(k.db.pool, at(401), ctx());                  // saglik geldi: PENDING yeniden baslar, hemen olay YOK
    expect(await incidents(r)).toHaveLength(0);
    expect(await state(r, d)).toBe("pending");
  });

  it("ingest sagliksizken metrik kurallari etkilenmez (yalniz cevrimdisi bastirilir)", async () => {
    const d = await device(k.org, "pc");
    const r = await rule(k.org, { for_seconds: 0 });
    await sample(k.org, d, "cpu.total", 99, -5);
    await evaluateAlerts(k.db.pool, at(0), ctx({ ingestHealthy: false }));
    expect(await incidents(r)).toHaveLength(1);
  });
});

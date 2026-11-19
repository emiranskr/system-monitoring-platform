import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AlertRuleSchema, AlertRulesResponseSchema, IncidentsResponseSchema, NotificationChannelSchema, NotificationChannelsResponseSchema, ChannelTestResponseSchema,
} from "@sysmon/protocol";
import { addUser, api, loginAs, setupKit, type Kit } from "./kit.js";

const PW = "yeterince-uzun-parola-1";
const UNKNOWN = "00000000-0000-4000-8000-000000000000";
const PUBLIC = [{ address: "93.184.216.34", family: 4 }];
let k: Kit;
let kNoKey: Kit;
let orgB = "";
let owner = "", admin = "", viewer = "", ownerB = "";
let devA = "", devB = "";
const q = (sql: string, p: unknown[] = []) => k.db.pool.query(sql, p);

const rule = (over: Record<string, unknown> = {}) => ({ name: "CPU yuksek", metric: "cpu.total", agg: "avg", window_seconds: 60, operator: ">", threshold: 90, for_seconds: 120, severity: "warning", ...over });
const hook = (over: Record<string, unknown> = {}) => ({ type: "webhook", name: "slack", url: "https://hooks.example.com/services/T0/B0/GIZLI-TOKEN", secret: "imza-SIRRI", ...over });
const mail = (over: Record<string, unknown> = {}) => ({ type: "email", name: "posta", host: "smtp.example.com", port: 587, user: "kullanici", pass: "PAROLA-SIRRI", from: "alarm@example.com", to: ["ali@example.com"], ...over });
const body = (r: { body: string }) => JSON.parse(r.body);

beforeAll(async () => {
  k = await setupKit({ alerts: { lookup: async () => PUBLIC } });
  orgB = (await q("INSERT INTO orgs (name) VALUES ('B-GIZLI-ORG') RETURNING id")).rows[0].id;
  devA = (await q("INSERT INTO devices (org_id, name) VALUES ($1,'a-pc') RETURNING id", [k.org])).rows[0].id;
  devB = (await q("INSERT INTO devices (org_id, name) VALUES ($1,'B-GIZLI-PC') RETURNING id", [orgB])).rows[0].id;
  await addUser(k, "owner@example.com", PW, "owner");
  await addUser(k, "admin@example.com", PW, "admin");
  await addUser(k, "viewer@example.com", PW, "viewer");
  await addUser(k, "ownerb@example.com", PW, "owner", orgB);
  owner = await loginAs(k, "owner@example.com", PW);
  admin = await loginAs(k, "admin@example.com", PW);
  viewer = await loginAs(k, "viewer@example.com", PW);
  ownerB = await loginAs(k, "ownerb@example.com", PW);
  kNoKey = await setupKit({ channelKey: null, alerts: { lookup: async () => PUBLIC } });
}, 180_000);
afterAll(async () => { await k?.close(); await kNoKey?.close(); });

describe("roller: viewer yalniz okur; yazma admin|owner", () => {
  it("viewer GET'leri gorur; POST/PATCH/DELETE 403", async () => {
    for (const url of ["/api/v1/alert-rules", "/api/v1/notification-channels", "/api/v1/incidents"]) expect((await api(k, "GET", url, { cookie: viewer })).statusCode).toBe(200);
    expect((await api(k, "POST", "/api/v1/alert-rules", { cookie: viewer, body: rule() })).statusCode).toBe(403);
    expect((await api(k, "POST", "/api/v1/notification-channels", { cookie: viewer, body: hook() })).statusCode).toBe(403);
    expect((await api(k, "PATCH", `/api/v1/alert-rules/${UNKNOWN}`, { cookie: viewer, body: { enabled: false } })).statusCode).toBe(403);
    expect((await api(k, "DELETE", `/api/v1/alert-rules/${UNKNOWN}`, { cookie: viewer })).statusCode).toBe(403);
    expect((await api(k, "DELETE", `/api/v1/notification-channels/${UNKNOWN}`, { cookie: viewer })).statusCode).toBe(403);
    expect((await api(k, "POST", `/api/v1/notification-channels/${UNKNOWN}/test`, { cookie: viewer })).statusCode).toBe(403);
  });

  it("admin yazabilir; Origin olmadan (CSRF) PATCH/DELETE/POST 403", async () => {
    expect((await api(k, "POST", "/api/v1/alert-rules", { cookie: admin, body: rule({ name: "admin kurali" }) })).statusCode).toBe(201);
    expect((await api(k, "POST", "/api/v1/alert-rules", { cookie: admin, body: rule(), origin: null })).statusCode).toBe(403);
    expect((await api(k, "DELETE", `/api/v1/alert-rules/${UNKNOWN}`, { cookie: admin, origin: null })).statusCode).toBe(403);
    expect((await api(k, "POST", "/api/v1/alert-rules", { cookie: admin, body: rule(), origin: "https://evil.example" })).statusCode).toBe(403);
  });
});

describe("kurallar", () => {
  it("liste: 4 yerlesik kural (sozlesmeye uygun), kullanici kurallari sonda", async () => {
    const r = await api(k, "GET", "/api/v1/alert-rules", { cookie: owner });
    expect(r.statusCode).toBe(200);
    const list = AlertRulesResponseSchema.parse(body(r)).rules;
    expect(list.filter((x) => x.builtin).map((x) => x.builtin).sort()).toEqual(["cpu_high", "disk_full", "mem_high", "offline"]);
    const offline = list.find((x) => x.builtin === "offline")!;
    expect(offline).toMatchObject({ metric: "device.offline", threshold: 60, for_seconds: 300, severity: "critical", enabled: true });
    const again = AlertRulesResponseSchema.parse(body(await api(k, "GET", "/api/v1/alert-rules", { cookie: owner }))).rules;
    expect(again.filter((x) => x.builtin)).toHaveLength(4);          // tekrar listelemek cogaltmaz
  });

  it("olusturma: 201, sozlesmeye uygun, varsayilanlar; org'a ozel", async () => {
    const r = await api(k, "POST", "/api/v1/alert-rules", { cookie: owner, body: rule({ name: "GPU sicak", metric: "gpu.*.temp_c", agg: "max", threshold: 85, hysteresis: 5 }) });
    expect(r.statusCode).toBe(201);
    const got = AlertRuleSchema.parse(body(r));
    expect(got).toMatchObject({ name: "GPU sicak", metric: "gpu.*.temp_c", hysteresis: 5, scope_device_ids: null, channel_ids: [], enabled: true, builtin: null });
    const bList = AlertRulesResponseSchema.parse(body(await api(k, "GET", "/api/v1/alert-rules", { cookie: ownerB }))).rules;
    expect(bList.map((x) => x.id)).not.toContain(got.id);
  });

  it.each([
    ["SQL enjeksiyonlu metrik", { metric: "cpu.total'; DROP TABLE alert_rules;--" }],
    ["izin disi metrik", { metric: "mem.total_bytes" }], ["izin disi operator", { operator: "<>" }], ["izin disi agg", { agg: "p99" }],
    ["NaN esik (JSON null)", { threshold: null }], ["negatif for", { for_seconds: -5 }], ["bilinmeyen alan", { builtin: "offline" }],
    ["org_id enjeksiyonu", { org_id: UNKNOWN }], ["kisa pencere", { window_seconds: 1 }],
  ])("%s -> 400", async (_n, over) => {
    expect((await api(k, "POST", "/api/v1/alert-rules", { cookie: owner, body: rule(over) })).statusCode).toBe(400);
  });
  it("tablo SQL enjeksiyonundan sonra saglam", async () => {
    expect((await q("SELECT count(*)::int AS n FROM alert_rules")).rows[0].n).toBeGreaterThan(0);
  });

  it("baska organizasyonun cihazi/kanali kuralda basvurulamaz (400 invalid_reference); varligi sizdirilmaz", async () => {
    const chB = body(await api(k, "POST", "/api/v1/notification-channels", { cookie: ownerB, body: hook({ name: "B-kanal" }) })).id;
    const a = await api(k, "POST", "/api/v1/alert-rules", { cookie: owner, body: rule({ scope_device_ids: [devB] }) });
    const b = await api(k, "POST", "/api/v1/alert-rules", { cookie: owner, body: rule({ channel_ids: [chB] }) });
    const c = await api(k, "POST", "/api/v1/alert-rules", { cookie: owner, body: rule({ channel_ids: [UNKNOWN] }) });
    for (const r of [a, b, c]) { expect(r.statusCode).toBe(400); expect(body(r)).toEqual({ error: "invalid_reference" }); }
    expect(a.body + b.body).not.toContain("B-GIZLI");
    const ok = await api(k, "POST", "/api/v1/alert-rules", { cookie: owner, body: rule({ scope_device_ids: [devA] }) });
    expect(ok.statusCode).toBe(201);
  });

  it("PATCH: yalniz verilen alan degisir (varsayilanlar diger alanlari SIFIRLAMAZ)", async () => {
    const created = AlertRuleSchema.parse(body(await api(k, "POST", "/api/v1/alert-rules", { cookie: owner, body: rule({ name: "yama", hysteresis: 7, scope_device_ids: [devA], threshold: 77 }) })));
    const r = await api(k, "PATCH", `/api/v1/alert-rules/${created.id}`, { cookie: owner, body: { enabled: false } });
    expect(r.statusCode).toBe(200);
    expect(AlertRuleSchema.parse(body(r))).toMatchObject({ enabled: false, hysteresis: 7, scope_device_ids: [devA], threshold: 77, name: "yama", for_seconds: 120 });
    const r2 = await api(k, "PATCH", `/api/v1/alert-rules/${created.id}`, { cookie: owner, body: { threshold: 50, operator: ">=" } });
    expect(AlertRuleSchema.parse(body(r2))).toMatchObject({ threshold: 50, operator: ">=", hysteresis: 7, enabled: false });
    expect((await api(k, "PATCH", `/api/v1/alert-rules/${created.id}`, { cookie: owner, body: {} })).statusCode).toBe(400);
    expect((await api(k, "PATCH", `/api/v1/alert-rules/${created.id}`, { cookie: owner, body: { metric: "x.y" } })).statusCode).toBe(400);
  });

  it("I-1: kullanilan kanal silinse de kural PATCH'lenebilir; kanal kuralin listesinden cikar; silinmis kanal yeni baglanamaz", async () => {
    const ch = body(await api(k, "POST", "/api/v1/notification-channels", { cookie: owner, body: hook({ name: "gecici" }) })).id;
    const r = AlertRuleSchema.parse(body(await api(k, "POST", "/api/v1/alert-rules", { cookie: owner, body: rule({ name: "kanalli", channel_ids: [ch] }) })));
    expect((await api(k, "DELETE", `/api/v1/notification-channels/${ch}`, { cookie: owner })).statusCode).toBe(204);
    const listed = body(await api(k, "GET", "/api/v1/alert-rules", { cookie: owner })).rules.find((x: { id: string }) => x.id === r.id);
    expect(listed.channel_ids).toEqual([]);
    expect((await api(k, "PATCH", `/api/v1/alert-rules/${r.id}`, { cookie: owner, body: { enabled: false } })).statusCode).toBe(200);
    // DB'de eski (kirli) referans kalmis olsa bile yalniz enabled PATCH'i basarili olur
    await q("UPDATE alert_rules SET channel_ids = ARRAY[$2::uuid] WHERE id = $1", [r.id, ch]);
    expect((await api(k, "PATCH", `/api/v1/alert-rules/${r.id}`, { cookie: owner, body: { enabled: true } })).statusCode).toBe(200);
    expect((await api(k, "PATCH", `/api/v1/alert-rules/${r.id}`, { cookie: owner, body: { channel_ids: [ch] } })).statusCode).toBe(400);
  });

  it("yerlesik kural: esik/etkin degisir; metrik/ad degismez (400); silinemez (409)", async () => {
    const offline = AlertRulesResponseSchema.parse(body(await api(k, "GET", "/api/v1/alert-rules", { cookie: owner }))).rules.find((x) => x.builtin === "offline")!;
    expect((await api(k, "PATCH", `/api/v1/alert-rules/${offline.id}`, { cookie: owner, body: { threshold: 120, enabled: false } })).statusCode).toBe(200);
    expect((await api(k, "PATCH", `/api/v1/alert-rules/${offline.id}`, { cookie: owner, body: { metric: "cpu.total" } })).statusCode).toBe(400);
    expect((await api(k, "PATCH", `/api/v1/alert-rules/${offline.id}`, { cookie: owner, body: { name: "x" } })).statusCode).toBe(400);
    expect((await api(k, "DELETE", `/api/v1/alert-rules/${offline.id}`, { cookie: owner })).statusCode).toBe(409);
  });

  it("silme: 204, listeden kalkar (yumusak); ikinci silme 404", async () => {
    const created = AlertRuleSchema.parse(body(await api(k, "POST", "/api/v1/alert-rules", { cookie: owner, body: rule({ name: "silinecek" }) })));
    expect((await api(k, "DELETE", `/api/v1/alert-rules/${created.id}`, { cookie: owner })).statusCode).toBe(204);
    expect(AlertRulesResponseSchema.parse(body(await api(k, "GET", "/api/v1/alert-rules", { cookie: owner }))).rules.map((x) => x.id)).not.toContain(created.id);
    expect((await api(k, "DELETE", `/api/v1/alert-rules/${created.id}`, { cookie: owner })).statusCode).toBe(404);
    expect((await q("SELECT deleted_at FROM alert_rules WHERE id = $1", [created.id])).rows[0].deleted_at).not.toBeNull();
  });

  it("IDOR: baska org'un kurali PATCH/DELETE'te olmayanla AYNI 404; uuid olmayan da 404", async () => {
    const mine = AlertRuleSchema.parse(body(await api(k, "POST", "/api/v1/alert-rules", { cookie: ownerB, body: rule({ name: "B-GIZLI-KURAL" }) })));
    for (const [m, url, b] of [["PATCH", `/api/v1/alert-rules/${mine.id}`, { enabled: false }], ["DELETE", `/api/v1/alert-rules/${mine.id}`, undefined]] as const) {
      const other = await api(k, m, url, { cookie: owner, body: b });
      const missing = await api(k, m, url.replace(mine.id, UNKNOWN), { cookie: owner, body: b });
      expect(other.statusCode).toBe(404);
      expect({ s: other.statusCode, b: other.body }).toEqual({ s: missing.statusCode, b: missing.body });
      expect(other.body).not.toContain("B-GIZLI");
    }
    expect((await api(k, "PATCH", "/api/v1/alert-rules/gecersiz", { cookie: owner, body: { enabled: false } })).statusCode).toBe(404);
    const still = AlertRulesResponseSchema.parse(body(await api(k, "GET", "/api/v1/alert-rules", { cookie: ownerB }))).rules.find((x) => x.id === mine.id);
    expect(still?.enabled).toBe(true);                                // B'nin kurali degismedi
  });
});

describe("kanallar", () => {
  it("webhook olustur: ozet YALNIZ ana makine; yanit ve liste URL yolunu/gizli token/imza sirrini ICERMEZ; DB'de sifreli", async () => {
    const r = await api(k, "POST", "/api/v1/notification-channels", { cookie: owner, body: hook() });
    expect(r.statusCode).toBe(201);
    const ch = NotificationChannelSchema.parse(body(r));
    expect(ch.summary).toEqual({ host: "hooks.example.com" });
    const list = await api(k, "GET", "/api/v1/notification-channels", { cookie: owner });
    NotificationChannelsResponseSchema.parse(body(list));
    for (const text of [r.body, list.body]) for (const s of ["GIZLI-TOKEN", "imza-SIRRI", "/services/"]) expect(text).not.toContain(s);
    const enc = (await q("SELECT config_enc FROM notification_channels WHERE id = $1", [ch.id])).rows[0].config_enc as Buffer;
    for (const s of ["GIZLI-TOKEN", "imza-SIRRI", "hooks.example.com"]) expect(enc.toString("latin1")).not.toContain(s);
  });

  it("e-posta olustur: ozet {host, port, recipients}; parola/kullanici/alici HICBIR yanitta yok; denetim kaydi sir icermez", async () => {
    const r = await api(k, "POST", "/api/v1/notification-channels", { cookie: owner, body: mail() });
    expect(r.statusCode).toBe(201);
    expect(NotificationChannelSchema.parse(body(r)).summary).toEqual({ host: "smtp.example.com", port: 587, recipients: 1 });
    const list = await api(k, "GET", "/api/v1/notification-channels", { cookie: owner });
    for (const s of ["PAROLA-SIRRI", "kullanici", "ali@example.com", "alarm@example.com"]) { expect(r.body).not.toContain(s); expect(list.body).not.toContain(s); }
    const audit = (await q("SELECT detail FROM audit_events WHERE kind = 'notification_channel_created'")).rows.map((x) => JSON.stringify(x.detail)).join("");
    for (const s of ["PAROLA-SIRRI", "GIZLI-TOKEN", "imza-SIRRI", "smtp.example.com"]) expect(audit).not.toContain(s);
  });

  it("SSRF: ozel/loopback/link-local/IP-literal hedefler olusturmada REDDEDILIR (400 blocked_target); http:// ve URL kimlik bilgisi reddedilir", async () => {
    for (const url of ["https://127.0.0.1/x", "https://169.254.169.254/latest/meta-data", "https://10.0.0.5/x", "https://[::1]/x", "https://192.168.1.1/x"]) {
      const r = await api(k, "POST", "/api/v1/notification-channels", { cookie: owner, body: hook({ url }) });
      expect(r.statusCode, url).toBe(400);
      expect(body(r)).toEqual({ error: "blocked_target" });
    }
    expect((await api(k, "POST", "/api/v1/notification-channels", { cookie: owner, body: hook({ url: "http://hooks.example.com/x" }) })).statusCode).toBe(400);
    expect((await api(k, "POST", "/api/v1/notification-channels", { cookie: owner, body: hook({ url: "https://u:p@hooks.example.com/x" }) })).statusCode).toBe(400);
    for (const host of ["127.0.0.1", "10.1.1.1", "169.254.169.254"])
      expect((await api(k, "POST", "/api/v1/notification-channels", { cookie: owner, body: mail({ host }) })).statusCode).toBe(400);
  });

  it("DNS ile ozel adrese cozumlenen ad reddedilir (olusturmada)", async () => {
    const kPriv = await setupKit({ alerts: { lookup: async () => [{ address: "10.0.0.7", family: 4 }] } });
    try {
      await addUser(kPriv, "o@example.com", PW, "owner");
      const c = await loginAs(kPriv, "o@example.com", PW);
      const r = await api(kPriv, "POST", "/api/v1/notification-channels", { cookie: c, body: hook() });
      expect(body(r)).toEqual({ error: "blocked_target" });
    } finally { await kPriv.close(); }
  });

  it("sir anahtari YOK: kanal olusturma 503 secrets_unavailable ve HICBIR satir yazilmaz", async () => {
    await addUser(kNoKey, "o@example.com", PW, "owner");
    const c = await loginAs(kNoKey, "o@example.com", PW);
    const r = await api(kNoKey, "POST", "/api/v1/notification-channels", { cookie: c, body: hook() });
    expect(r.statusCode).toBe(503);
    expect(body(r)).toEqual({ error: "secrets_unavailable" });
    expect((await kNoKey.db.pool.query("SELECT count(*)::int AS n FROM notification_channels")).rows[0].n).toBe(0);
  });

  it("gecersiz govde: bilinmeyen tur, eksik alan, bozuk e-posta -> 400", async () => {
    for (const b of [{ type: "sms", name: "x" }, { type: "webhook", name: "x" }, mail({ from: "gecersiz" }), mail({ to: ["a@b"] }), mail({ to: ["a@example.com\r\nBcc: x@evil.test"] }), hook({ extra: 1 })])
      expect((await api(k, "POST", "/api/v1/notification-channels", { cookie: owner, body: b })).statusCode).toBe(400);
  });

  it("silme: 204; bekleyen bildirimler failed; baska org'un kanali olmayanla AYNI 404", async () => {
    const id = body(await api(k, "POST", "/api/v1/notification-channels", { cookie: owner, body: hook({ name: "silinecek" }) })).id;
    await api(k, "POST", `/api/v1/notification-channels/${id}/test`, { cookie: owner });
    const bId = body(await api(k, "POST", "/api/v1/notification-channels", { cookie: ownerB, body: hook({ name: "B-GIZLI-KANAL" }) })).id;
    const other = await api(k, "DELETE", `/api/v1/notification-channels/${bId}`, { cookie: owner });
    const missing = await api(k, "DELETE", `/api/v1/notification-channels/${UNKNOWN}`, { cookie: owner });
    expect({ s: other.statusCode, b: other.body }).toEqual({ s: missing.statusCode, b: missing.body });
    expect(other.statusCode).toBe(404);
    expect((await api(k, "DELETE", `/api/v1/notification-channels/${id}`, { cookie: owner })).statusCode).toBe(204);
    expect((await q("SELECT status, last_error FROM notifications WHERE channel_id = $1", [id])).rows).toEqual([{ status: "failed", last_error: "kanal silindi" }]);
    expect((await q("SELECT deleted_at FROM notification_channels WHERE id = $1", [bId])).rows[0].deleted_at).toBeNull();   // B'nin kanali silinmedi
  });

  it("D1: kanal silme TEK transaction: ara adim basarisiz olursa kanal SILINMIS KALMAZ (kismi durum yok)", async () => {
    const id = body(await api(k, "POST", "/api/v1/notification-channels", { cookie: owner, body: hook({ name: "atomik" }) })).id;
    await api(k, "POST", `/api/v1/notification-channels/${id}/test`, { cookie: owner });
    await q("CREATE OR REPLACE FUNCTION d1_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'd1 test hatasi'; END $$ LANGUAGE plpgsql");
    await q("CREATE TRIGGER d1_trg BEFORE UPDATE ON notifications FOR EACH ROW EXECUTE FUNCTION d1_fail()");
    try {
      const r = await api(k, "DELETE", `/api/v1/notification-channels/${id}`, { cookie: owner });
      expect(r.statusCode).toBe(500);
      expect((await q("SELECT deleted_at FROM notification_channels WHERE id = $1", [id])).rows[0].deleted_at).toBeNull();   // geri alindi
    } finally {
      await q("DROP TRIGGER d1_trg ON notifications"); await q("DROP FUNCTION d1_fail()");
    }
    expect((await api(k, "DELETE", `/api/v1/notification-channels/${id}`, { cookie: owner })).statusCode).toBe(204);   // tetikleyici yokken calisir
  });

  it("M-pencere: kural penceresi en az 2 ornekleme araligi olmali (aksi halde pencere bazen bos kalir ve sureli kural tetiklenemez); POST ve PATCH, yalniz o kuralin pencere alani", async () => {
    const slow = await setupKit({ sampleIntervalSeconds: 30, alerts: { lookup: async () => PUBLIC } });
    try {
      await addUser(slow, "o30@example.com", PW, "owner");
      const c = await loginAs(slow, "o30@example.com", PW);
      const bad = await api(slow, "POST", "/api/v1/alert-rules", { cookie: c, body: rule({ window_seconds: 45 }) });      // 45 < 2*30
      expect(bad.statusCode).toBe(400);
      expect(body(bad).error).toBe("window_too_small");
      const ok = await api(slow, "POST", "/api/v1/alert-rules", { cookie: c, body: rule({ window_seconds: 60 }) });       // tam sinir: kabul
      expect(ok.statusCode).toBe(201);
      const id = body(ok).id;
      expect((await api(slow, "PATCH", `/api/v1/alert-rules/${id}`, { cookie: c, body: { window_seconds: 30 } })).statusCode).toBe(400);
      expect((await api(slow, "PATCH", `/api/v1/alert-rules/${id}`, { cookie: c, body: { threshold: 50 } })).statusCode).toBe(200);   // ilgisiz alan etkilenmez
    } finally { await slow.close(); }
    // varsayilan aralik (5 sn): en kucuk pencere (15 sn) gecerli
    expect((await api(k, "POST", "/api/v1/alert-rules", { cookie: owner, body: rule({ window_seconds: 15, name: "kucuk-pencere" }) })).statusCode).toBe(201);
  });

  it("test bildirimi: 202 kuyruga eklenir (olaysiz, kind=test); baska org 404; silinmis kanal 404; hiz siniri 429", async () => {
    const id = body(await api(k, "POST", "/api/v1/notification-channels", { cookie: admin, body: hook({ name: "test-kanali" }) })).id;
    const r = await api(k, "POST", `/api/v1/notification-channels/${id}/test`, { cookie: admin });
    expect(r.statusCode).toBe(202);
    ChannelTestResponseSchema.parse(body(r));
    expect((await q("SELECT kind, status, incident_id FROM notifications WHERE channel_id = $1", [id])).rows).toEqual([{ kind: "test", status: "pending", incident_id: null }]);
    expect((await api(k, "POST", `/api/v1/notification-channels/${id}/test`, { cookie: ownerB })).statusCode).toBe(404);
    let last = 202;
    for (let i = 0; i < 8; i++) last = (await api(k, "POST", `/api/v1/notification-channels/${id}/test`, { cookie: admin })).statusCode;
    expect(last).toBe(429);
    await api(k, "DELETE", `/api/v1/notification-channels/${id}`, { cookie: owner });
    expect((await api(k, "POST", `/api/v1/notification-channels/${id}/test`, { cookie: owner })).statusCode).toBe(404);
  });
});

describe("olaylar", () => {
  it("yalniz kendi org'unun olaylari; durum ve limit filtreleri; en yeni once; sozlesmeye uygun; gecersiz sorgu 400", async () => {
    const mk = async (org: string, dev: string, name: string, minutesAgo: number, resolved: boolean) => {
      const r = (await q("INSERT INTO alert_rules (org_id,name,metric,agg,window_seconds,operator,threshold,for_seconds,severity) VALUES ($1,$2,'cpu.total','avg',60,'>',90,0,'warning') RETURNING id", [org, name])).rows[0].id;
      const t = new Date(Date.now() - minutesAgo * 60_000);
      await q("INSERT INTO incidents (org_id, rule_id, device_id, rule_name, device_name, metric, severity, opened_at, resolved_at, last_value, peak_value) VALUES ($1,$2,$3,$4,'cihaz','cpu.total','warning',$5,$6,95,99)",
        [org, r, dev, name, t, resolved ? new Date(t.getTime() + 60_000) : null]);
    };
    await mk(k.org, devA, "A-eski-cozulmus", 30, true);
    await mk(k.org, devA, "A-yeni-acik", 5, false);
    await mk(orgB, devB, "B-GIZLI-OLAY", 1, false);
    const all = IncidentsResponseSchema.parse(body(await api(k, "GET", "/api/v1/incidents", { cookie: viewer })));
    expect(all.incidents.map((i) => i.rule_name)).toEqual(["A-yeni-acik", "A-eski-cozulmus"]);
    expect(JSON.stringify(all)).not.toContain("B-GIZLI");
    expect(IncidentsResponseSchema.parse(body(await api(k, "GET", "/api/v1/incidents?state=open", { cookie: viewer }))).incidents.map((i) => i.rule_name)).toEqual(["A-yeni-acik"]);
    expect(IncidentsResponseSchema.parse(body(await api(k, "GET", "/api/v1/incidents?state=resolved", { cookie: viewer }))).incidents.map((i) => i.rule_name)).toEqual(["A-eski-cozulmus"]);
    expect(IncidentsResponseSchema.parse(body(await api(k, "GET", "/api/v1/incidents?limit=1", { cookie: viewer }))).incidents).toHaveLength(1);
    for (const bad of ["state=x", "limit=0", "limit=201", "limit=abc", "extra=1"]) expect((await api(k, "GET", `/api/v1/incidents?${bad}`, { cookie: viewer })).statusCode, bad).toBe(400);
    const b = IncidentsResponseSchema.parse(body(await api(k, "GET", "/api/v1/incidents", { cookie: ownerB })));
    expect(b.incidents.map((i) => i.rule_name)).toEqual(["B-GIZLI-OLAY"]);
  });
});

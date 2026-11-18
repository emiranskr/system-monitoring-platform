import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { processNotifications, type NotifierDeps } from "../src/alerts/notifier.js";
import { randomUUID } from "node:crypto";
import { channelAad, encryptSecret } from "../src/alerts/secrets.js";
import { FakeSmtp } from "./fake-smtp.js";
import { setupKit, type Kit } from "./kit.js";

const KEY = Buffer.alloc(32, 5);
let k: Kit;
let rule: string, dev: string;
let receiver: http.Server;
let rport: number;
let rhits: { headers: http.IncomingHttpHeaders; body: string }[] = [];
let rstatus = 200;
const T0 = new Date("2026-11-18T12:00:00Z");
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);
const q = (sql: string, p: unknown[] = []) => k.db.pool.query(sql, p);

const deps = (now: Date, over: Partial<NotifierDeps> = {}): NotifierDeps => ({
  secretKey: KEY, now: () => now,
  webhook: { allowPrivate: true, allowInsecureHttp: true, timeoutMs: 2000 },
  email: { allowPrivate: true, allowInsecure: true, timeoutMs: 2000 },
  ...over,
});

async function webhookChannel(org = k.org, path = "/hook/TOKEN-SIRRI") {
  const cfg = { url: `http://127.0.0.1:${rport}${path}`, secret: "imza" };
  const id = randomUUID();
  await q("INSERT INTO notification_channels (id, org_id, name, type, config_enc, summary) VALUES ($1,$2,'w','webhook',$3,'{}')", [id, org, encryptSecret(KEY, JSON.stringify(cfg), channelAad(org, id))]);
  return id;
}
let incSeq = 0;
async function notif(channel: string, over: { kind?: string; incident?: boolean; next?: Date; status?: string; lease?: Date | null; attempts?: number } = {}) {
  let incidentId: string | null = null;
  if (over.incident !== false) {
    // benzersiz (kural, cihaz) icin acik olay kisiti: her olay icin kapali olay
    incidentId = (await q(
      `INSERT INTO incidents (org_id, rule_id, device_id, rule_name, device_name, metric, severity, opened_at, resolved_at)
       VALUES ($1,$2,$3,'kural','cihaz','cpu.total','warning',$4,$4) RETURNING id`, [k.org, rule, dev, at(incSeq++)])).rows[0].id;
  }
  return (await q(
    `INSERT INTO notifications (org_id, incident_id, channel_id, kind, status, next_attempt_at, lease_until, attempts, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [k.org, incidentId, channel, over.kind ?? "firing", over.status ?? "pending", over.next ?? at(0), over.lease ?? null, over.attempts ?? 0,
      JSON.stringify({ kind: over.kind ?? "firing", dedupe_key: `${incidentId ?? "test"}:${over.kind ?? "firing"}`, rule_name: "kural", device_name: "cihaz", severity: "warning", metric: "cpu.total", value: 95, operator: ">", threshold: 90, opened_at: at(0).toISOString(), resolved_at: null })])).rows[0].id as string;
}
const row = async (id: string) => (await q("SELECT * FROM notifications WHERE id = $1", [id])).rows[0];

beforeAll(async () => {
  k = await setupKit();
  dev = (await q("INSERT INTO devices (org_id, name) VALUES ($1,'pc') RETURNING id", [k.org])).rows[0].id;
  rule = (await q("INSERT INTO alert_rules (org_id,name,metric,agg,window_seconds,operator,threshold,for_seconds,severity) VALUES ($1,'r','cpu.total','avg',60,'>',90,0,'warning') RETURNING id", [k.org])).rows[0].id;
  receiver = http.createServer((req, res) => {
    const c: Buffer[] = [];
    req.on("data", (d) => c.push(d));
    req.on("end", () => { rhits.push({ headers: req.headers, body: Buffer.concat(c).toString() }); res.statusCode = rstatus; res.end("x"); });
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  rport = (receiver.address() as AddressInfo).port;
}, 120_000);
afterAll(async () => { receiver.closeAllConnections(); await new Promise((r) => receiver.close(r)); await k?.close(); });
beforeEach(async () => {
  rhits = []; rstatus = 200;
  await q("DELETE FROM notifications"); await q("DELETE FROM incidents"); await q("DELETE FROM notification_channels");
});

describe("kalici bildirim kuyrugu: teslimat", () => {
  it("bekleyen bildirim webhook'a teslim edilir: sent, sent_at, attempts=1; dedupe basligi ve sir imzasi; govde payload", async () => {
    const ch = await webhookChannel();
    const id = await notif(ch);
    const r = await processNotifications(k.db.pool, deps(at(0)));
    expect(r).toMatchObject({ sent: 1, retried: 0, failed: 0 });
    const n = await row(id);
    expect(n.status).toBe("sent");
    expect(n.attempts).toBe(1);
    expect(n.sent_at).not.toBeNull();
    expect(rhits).toHaveLength(1);
    expect(rhits[0]!.headers["x-sysmon-dedupe"]).toContain(":firing");
    expect(rhits[0]!.headers["x-sysmon-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(JSON.parse(rhits[0]!.body).rule_name).toBe("kural");
  });

  it("GONDERILMIS (sent) bildirim bir daha ASLA gonderilmez", async () => {
    const ch = await webhookChannel();
    await notif(ch);
    await processNotifications(k.db.pool, deps(at(0)));
    await processNotifications(k.db.pool, deps(at(600)));
    await processNotifications(k.db.pool, deps(at(7200)));
    expect(rhits).toHaveLength(1);
  });

  it("gecici hata: pending'e doner, ustel geri cekilme (30 sn), vadesi gelmeden denenmez; sonra basari -> TEK basarili teslimat", async () => {
    const ch = await webhookChannel();
    const id = await notif(ch);
    rstatus = 500;
    expect(await processNotifications(k.db.pool, deps(at(0)))).toMatchObject({ sent: 0, retried: 1, failed: 0 });
    let n = await row(id);
    expect(n).toMatchObject({ status: "pending", attempts: 1, last_error: "HTTP 500" });
    expect(new Date(n.next_attempt_at).getTime()).toBe(at(30).getTime());

    await processNotifications(k.db.pool, deps(at(29)));
    expect(rhits).toHaveLength(1);                                    // vade dolmadi: istek yok

    rstatus = 200;
    await processNotifications(k.db.pool, deps(at(30)));
    n = await row(id);
    expect(n).toMatchObject({ status: "sent", attempts: 2 });
    expect(rhits.filter(() => true)).toHaveLength(2);                // 1 basarisiz + 1 basarili deneme
  });

  it("geri cekilme ustel (30, 60, 120 sn ...) ve 15 dk ile sinirli", async () => {
    const ch = await webhookChannel();
    const id = await notif(ch);
    rstatus = 500;
    let now = at(0);
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      await processNotifications(k.db.pool, deps(now, { maxAttempts: 50 }));
      const n = await row(id);
      delays.push((new Date(n.next_attempt_at).getTime() - now.getTime()) / 1000);
      now = new Date(n.next_attempt_at);
    }
    expect(delays).toEqual([30, 60, 120, 240, 480, 900]);
    for (let i = 0; i < 3; i++) {
      await processNotifications(k.db.pool, deps(now, { maxAttempts: 50 }));
      const n = await row(id);
      expect((new Date(n.next_attempt_at).getTime() - now.getTime()) / 1000).toBe(900);
      now = new Date(n.next_attempt_at);
    }
  });

  it("kalici hata (4xx): hemen failed; azami deneme asilinca failed", async () => {
    const ch = await webhookChannel();
    rstatus = 400;
    const id = await notif(ch);
    expect(await processNotifications(k.db.pool, deps(at(0)))).toMatchObject({ failed: 1 });
    expect(await row(id)).toMatchObject({ status: "failed", attempts: 1 });

    rstatus = 503;
    const id2 = await notif(ch);
    let now = at(0);
    for (let i = 0; i < 3; i++) { await processNotifications(k.db.pool, deps(now, { maxAttempts: 3 })); now = new Date((await row(id2)).next_attempt_at); }
    expect(await row(id2)).toMatchObject({ status: "failed", attempts: 3 });
  });
});

describe("kalici bildirim kuyrugu: yeniden baslatma ve es zamanlilik", () => {
  it("yeniden baslatma: kira suresi dolmus 'sending' satiri (calisan coktu) yeniden alinip teslim edilir; kirasi suren satira DOKUNULMAZ", async () => {
    const ch = await webhookChannel();
    const stale = await notif(ch, { status: "sending", lease: at(-5), attempts: 1 });
    const live = await notif(ch, { status: "sending", lease: at(60), attempts: 1 });
    await processNotifications(k.db.pool, deps(at(0)));
    expect((await row(stale)).status).toBe("sent");
    expect((await row(live)).status).toBe("sending");
    expect(rhits).toHaveLength(1);
  });

  it("iki es zamanli isleyici AYNI bildirimi iki kez gondermez (SKIP LOCKED)", async () => {
    const ch = await webhookChannel();
    for (let i = 0; i < 5; i++) await notif(ch);
    await Promise.all([processNotifications(k.db.pool, deps(at(0))), processNotifications(k.db.pool, deps(at(0))), processNotifications(k.db.pool, deps(at(0)))]);
    expect(rhits).toHaveLength(5);
    expect((await q("SELECT count(*)::int AS n FROM notifications WHERE status='sent'")).rows[0].n).toBe(5);
  });

  it("kanal basina hizlimit: dakikada en cok N gonderim, fazlasi ertelenir (deneme HAKKI harcanmaz), sonra gonderilir", async () => {
    const ch = await webhookChannel();
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push(await notif(ch));
    await processNotifications(k.db.pool, deps(at(0), { ratePerMinute: 3 }));
    expect(rhits).toHaveLength(3);
    const waiting = (await q("SELECT attempts, status FROM notifications WHERE status <> 'sent'")).rows;
    expect(waiting).toHaveLength(5);
    expect(waiting.every((w) => w.status === "pending" && w.attempts === 0)).toBe(true);
    await processNotifications(k.db.pool, deps(at(61), { ratePerMinute: 3 }));
    await processNotifications(k.db.pool, deps(at(122), { ratePerMinute: 3 }));
    expect(rhits).toHaveLength(8);
  });
});

describe("kalici bildirim kuyrugu: guvenlik", () => {
  it("silinmis kanal: failed (gonderim yok); baska organizasyon kanali yapisal olarak baglanamaz", async () => {
    const ch = await webhookChannel();
    await q("UPDATE notification_channels SET deleted_at = now() WHERE id = $1", [ch]);
    const id = await notif(ch);
    await processNotifications(k.db.pool, deps(at(0)));
    expect(await row(id)).toMatchObject({ status: "failed" });
    expect(rhits).toHaveLength(0);
    const orgB = (await q("INSERT INTO orgs (name) VALUES ('B') RETURNING id")).rows[0].id;
    const chB = await webhookChannel(orgB);
    await expect(q("INSERT INTO notifications (org_id, channel_id, kind, status, next_attempt_at, payload) VALUES ($1,$2,'test','pending',now(),'{}')", [k.org, chB])).rejects.toThrow();
  });

  it("sir anahtari yok/gecersiz: gonderim YAPILMAZ, failed; hata metni sir icermez", async () => {
    const ch = await webhookChannel(k.org, "/hook/GIZLI-YOL");
    const id = await notif(ch);
    await processNotifications(k.db.pool, deps(at(0), { secretKey: undefined }));
    const n = await row(id);
    expect(n.status).toBe("failed");
    expect(String(n.last_error)).not.toContain("GIZLI-YOL");
    expect(rhits).toHaveLength(0);
    const id2 = await notif(await webhookChannel());
    await processNotifications(k.db.pool, deps(at(0), { secretKey: Buffer.alloc(32, 1) }));   // YANLIS anahtar
    expect((await row(id2)).status).toBe("failed");
    expect(rhits).toHaveLength(0);
  });

  it("kanal yapilandirmasi veritabaninda SIFRELI: URL/sir duz metin olarak bulunmaz", async () => {
    const ch = await webhookChannel(k.org, "/hook/GIZLI-YOL");
    const blob = (await q("SELECT config_enc FROM notification_channels WHERE id = $1", [ch])).rows[0].config_enc as Buffer;
    expect(blob.toString("latin1")).not.toContain("GIZLI-YOL");
    expect(blob.toString("latin1")).not.toContain("127.0.0.1");
  });

  it("kalici SSRF hatasi (allowPrivate kapali): failed, istek gitmez", async () => {
    const ch = await webhookChannel();
    const id = await notif(ch);
    await processNotifications(k.db.pool, deps(at(0), { webhook: { allowPrivate: false, allowInsecureHttp: true, timeoutMs: 1000 } }));
    expect((await row(id)).status).toBe("failed");
    expect(rhits).toHaveLength(0);
  });

  it("test bildirimi (olaysiz, kind=test) teslim edilir", async () => {
    const ch = await webhookChannel();
    const id = await notif(ch, { kind: "test", incident: false });
    await processNotifications(k.db.pool, deps(at(0)));
    expect((await row(id)).status).toBe("sent");
    expect(JSON.parse(rhits[0]!.body).kind).toBe("test");
  });
});

describe("kalici bildirim kuyrugu: e-posta kanali", () => {
  it("e-posta kanali sahte SMTP'ye teslim eder; sifreli yapilandirmada parola duz metin degil", async () => {
    const smtp = new FakeSmtp({ user: "u", pass: "PAROLA-SIRRI" });
    await smtp.start();
    try {
      const cfg = { host: "127.0.0.1", port: smtp.port, user: "u", pass: "PAROLA-SIRRI", from: "alarm@example.com", to: ["ali@example.com"] };
      const ch = randomUUID();
      const enc = encryptSecret(KEY, JSON.stringify(cfg), channelAad(k.org, ch));
      expect(enc.toString("latin1")).not.toContain("PAROLA-SIRRI");
      await q("INSERT INTO notification_channels (id, org_id, name, type, config_enc, summary) VALUES ($1,$2,'e','email',$3,'{}')", [ch, k.org, enc]);
      const id = await notif(ch);
      await processNotifications(k.db.pool, deps(at(0)));
      expect((await row(id)).status).toBe("sent");
      expect(smtp.messages).toHaveLength(1);
      expect(smtp.messages[0]!.authPass).toBe("PAROLA-SIRRI");
      expect(String((await row(id)).last_error ?? "")).not.toContain("PAROLA-SIRRI");
    } finally { await smtp.stop(); }
  });
});

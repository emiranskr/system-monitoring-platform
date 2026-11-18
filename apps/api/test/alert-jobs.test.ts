import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUser, api, loginAs, setupKit, type Kit } from "./kit.js";

/** Zamanlanmis isler gercekten bagli mi: degerlendirici -> olay -> KALICI kuyruk -> webhook (uctan uca, gercek DB + gercek HTTP alici). */
const PW = "yeterince-uzun-parola-1";
let k: Kit;
let receiver: http.Server;
let port = 0;
let hits: { headers: http.IncomingHttpHeaders; body: string }[] = [];
let cookie = "";

const until = async (cond: () => boolean | Promise<boolean>, ms = 15_000) => {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await cond()) return; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error("zaman asimi: kosul saglanmadi");
};

beforeAll(async () => {
  receiver = http.createServer((req, res) => {
    const c: Buffer[] = [];
    req.on("data", (d) => c.push(d));
    req.on("end", () => { hits.push({ headers: req.headers, body: Buffer.concat(c).toString() }); res.end("ok"); });
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  port = (receiver.address() as AddressInfo).port;
  k = await setupKit({ alerts: { jobs: true, evaluateMs: 150, notifyMs: 150, allowPrivateTargets: true, allowInsecureWebhooks: true } });
  await addUser(k, "o@example.com", PW, "owner");
  cookie = await loginAs(k, "o@example.com", PW);
}, 120_000);
afterAll(async () => { await k?.close(); receiver.closeAllConnections(); await new Promise((r) => receiver.close(r)); });

describe("uyari isleri: uctan uca", () => {
  it("esik asilinca olay acilir, webhook bildirimi tek kez teslim edilir; deger duzelince cozuldu bildirimi gelir", async () => {
    const q = (sql: string, p: unknown[] = []) => k.db.pool.query(sql, p);
    const dev = (await q("INSERT INTO devices (org_id, name, last_seen_at) VALUES ($1,'e2e-pc',$2) RETURNING id", [k.org, k.clock.now])).rows[0].id as string;
    const ch = (await api(k, "POST", "/api/v1/notification-channels", { cookie, body: { type: "webhook", name: "alici", url: `http://127.0.0.1:${port}/hook`, secret: "imza" } }));
    expect(ch.statusCode).toBe(201);
    const chId = JSON.parse(ch.body).id as string;
    const rule = await api(k, "POST", "/api/v1/alert-rules", { cookie, body: { name: "E2E CPU", metric: "cpu.total", agg: "max", window_seconds: 60, operator: ">", threshold: 90, for_seconds: 0, severity: "critical", channel_ids: [chId] } });
    expect(rule.statusCode).toBe(201);

    await q("INSERT INTO metric_samples (ts, org_id, device_id, metric, value) VALUES ($1,$2,$3,'cpu.total',99)", [new Date(k.clock.now.getTime() - 5_000), k.org, dev]);
    await until(() => hits.length >= 1);
    const first = JSON.parse(hits[0]!.body);
    expect(first).toMatchObject({ kind: "firing", rule_name: "E2E CPU", device_name: "e2e-pc", severity: "critical", metric: "cpu.total" });
    expect(hits[0]!.headers["x-sysmon-signature"]).toMatch(/^sha256=/);
    const open = JSON.parse((await api(k, "GET", "/api/v1/incidents?state=open", { cookie })).body).incidents;
    expect(open.map((i: { rule_name: string }) => i.rule_name)).toEqual(["E2E CPU"]);

    await new Promise((r) => setTimeout(r, 1200));                      // birkac tur daha: mukerrer bildirim olmamali
    expect(hits.filter((h) => JSON.parse(h.body).kind === "firing")).toHaveLength(1);

    // deger duzelir: saati ileri al, pencerede yalniz dusuk deger olsun
    k.clock.now = new Date(k.clock.now.getTime() + 120_000);
    await q("INSERT INTO metric_samples (ts, org_id, device_id, metric, value) VALUES ($1,$2,$3,'cpu.total',10)", [new Date(k.clock.now.getTime() - 5_000), k.org, dev]);
    await until(() => hits.some((h) => JSON.parse(h.body).kind === "resolved"));
    const resolved = (await api(k, "GET", "/api/v1/incidents?state=resolved", { cookie }));
    expect(JSON.parse(resolved.body).incidents).toHaveLength(1);
    expect(hits.filter((h) => JSON.parse(h.body).kind === "resolved")).toHaveLength(1);
  });
});

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@sysmon/db/testing";
import { buildApp } from "../src/app.js";
import { hashToken } from "../src/tokens.js";

/**
 * GERCEK uca-uca: gercek .NET agent (Debug derlemesi, loopback http bayragiyla) gercek Fastify API'ye ve gercek
 * TimescaleDB'ye veri gonderir; sonra API kapatilip (kesinti) yeniden acilir ve spool'un bosaldigi dogrulanir.
 * Yalnizca Windows'ta ve Agent.Service.exe derlenmisse kosar (aksi halde atlanir).
 */
const exe = resolve(__dirname, "../../../agent/windows/src/Agent.Service/bin/Debug/net10.0-windows/Agent.Service.exe");
const enabled = process.platform === "win32" && existsSync(exe);

describe.skipIf(!enabled)("agent <-> API uca-uca (gercek surec)", () => {
  let db: TestDb;
  let dataDir: string;
  let agent: ChildProcess | undefined;
  let app: FastifyInstance | undefined;
  const statuses: number[] = [];
  const seenAuth = new Set<string>();
  let org = "", device = "", port = 0;

  const startApi = async () => {
    // Sunucu agent'tan 1 sn ornekleme ister (varsayilan 5 sn): agent'in config.interval_seconds'e GERCEKTEN uydugunu da kanitlar.
    app = buildApp({ pool: db.pool, credentialKey: Buffer.alloc(32, 1), sampleIntervalSeconds: 1 });
    app.addHook("onResponse", async (req, reply) => {
      statuses.push(reply.statusCode);
      seenAuth.add(String(req.headers.authorization ?? "").slice(0, 7));
    });
    await app.listen({ port, host: "127.0.0.1" });
  };
  const rows = async (metric: string) =>
    (await db.pool.query("SELECT ts FROM metric_samples WHERE device_id=$1 AND metric=$2 ORDER BY ts", [device, metric])).rows.map((r) => (r.ts as Date).getTime());
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (cond: () => Promise<boolean>, ms: number, what: string) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await cond()) return; await sleep(500); }
    throw new Error(`Zaman asimi: ${what}`);
  };

  beforeAll(async () => {
    db = await createTestDb();
    org = (await db.pool.query("INSERT INTO orgs (name) VALUES ('e2e') RETURNING id")).rows[0].id;
    device = (await db.pool.query("INSERT INTO devices (org_id, name) VALUES ($1,'e2e-agent') RETURNING id", [org])).rows[0].id;
    const token = "tok_e2e_" + "a1b2c3d4e5f6".repeat(6);
    await db.pool.query("INSERT INTO device_tokens (token_hash, org_id, device_id) VALUES ($1,$2,$3)", [hashToken(token), org, device]);

    dataDir = mkdtempSync(join(tmpdir(), "sysmon-e2e-"));
    const plain = join(dataDir, "bootstrap.txt");
    writeFileSync(plain, token, "ascii");
    const imp = spawnSync(exe, ["--import-token", plain, "--data-dir", dataDir], { encoding: "utf8" });
    if (imp.status !== 0) throw new Error(`token import basarisiz: ${imp.stdout}${imp.stderr}`);

    // bos bir port bul
    const tmp = buildApp({ pool: db.pool, credentialKey: Buffer.alloc(32, 1), sampleIntervalSeconds: 1 });
    await tmp.listen({ port: 0, host: "127.0.0.1" });
    port = (tmp.server.address() as { port: number }).port;
    await tmp.close();
    await startApi();
  }, 120_000);

  afterAll(async () => {
    agent?.kill();
    await sleep(500);
    await app?.close().catch(() => undefined);
    await db?.drop();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  }, 60_000);

  it("agent veri yollar, API 200 doner; kesinti sonrasi spool bosalir; veri bosluksuz", async () => {
    agent = spawn(exe, ["--server", `http://127.0.0.1:${port}`, "--allow-insecure-loopback", "--data-dir", dataDir], { stdio: "ignore" });

    // 1) Baslangic: ilk veriler gelir
    await waitFor(async () => (await rows("mem.used_pct")).length >= 5, 45_000, "ilk veriler gelmedi");
    const before = (await rows("mem.used_pct")).length;

    // 2) Kesinti: API kapanir, agent 10+ sn spool'a biriktirir
    await app!.close();
    await sleep(12_000);

    // 3) API geri gelir: biriken batch'ler bosalir
    await startApi();
    await waitFor(async () => {
      const r = await rows("mem.used_pct");
      return r.length > before + 14 && r[r.length - 1]! > Date.now() - 15_000;
    }, 60_000, "kesinti sonrasi bosalma tamamlanmadi");
    agent.kill();
    await sleep(500);

    // --- dogrulamalar ---
    const ts = await rows("mem.used_pct");
    // Kesinti suresi (12 sn) icin de orneklerin geldigi: ardisik ornekler arasi bosluk <= 3 sn (1 sn ornekleme)
    const gaps = ts.slice(1).map((t, i) => t - ts[i]!);
    // Agent varsayilan 5 sn ile baslar, ilk onaydan sonra sunucunun istedigi 1 sn'ye GECER (config.interval_seconds).
    const firstFast = gaps.findIndex((g) => g <= 1500);
    expect(firstFast, `agent hic 1 sn'ye gecmedi (config uygulanmiyor): ${gaps.join(",")}`).toBeGreaterThanOrEqual(1);
    expect(gaps[0]!, "baslangic araligi varsayilan 5 sn olmali").toBeGreaterThanOrEqual(4000);
    // Gecis sonrasi (kesinti dahil) bosluk yok: ardisik ornekler arasi <= 3 sn, kesinti geri doldurulur.
    expect(Math.max(...gaps.slice(firstFast)), `en buyuk bosluk ms (kesinti geri doldurulmali): ${gaps.join(",")}`).toBeLessThanOrEqual(3000);
    expect(new Set(ts).size).toBe(ts.length); // yinelenen yok (PK zaten saglar; bos ts yok)

    // Agent'in gercek protokolu: 4xx/5xx yok (401 dahil), bearer sema kullanildi
    const bad = statuses.filter((s) => s >= 400);
    expect(bad, `beklenmeyen hata kodlari: ${bad.join(",")}`).toEqual([]);
    expect([...seenAuth]).toContain("Bearer ");

    // Tum satirlar yalniz bu cihaza/organizasyona ait; cihaz kimligi govdeden degil token'dan geldi
    const owners = (await db.pool.query("SELECT DISTINCT org_id::text, device_id::text FROM metric_samples")).rows;
    expect(owners).toEqual([{ org_id: org, device_id: device }]);

    // Beklenen metrik aileleri (collector'lar): bellek, disk ve ag mutlaka; cpu PDH izne bagli olabilir
    const names = new Set((await db.pool.query("SELECT DISTINCT metric FROM metric_samples")).rows.map((r) => r.metric as string));
    expect(names.has("mem.used_pct")).toBe(true);
    expect([...names].some((n) => n.startsWith("disk."))).toBe(true);
    expect([...names].some((n) => n.startsWith("net."))).toBe(true);

    // seq sayaci ilerledi ve epoch tek
    const st = (await db.pool.query("SELECT count(*)::int AS epochs, max(last_seq)::int AS last FROM device_ingest_state WHERE device_id=$1", [device])).rows[0];
    expect(st.epochs).toBe(1);
    expect(st.last).toBeGreaterThanOrEqual(3); // 5 sn'lik batch'lerle >= 20 ornek >= 4 batch (seq 0..3)
  }, 240_000);
});

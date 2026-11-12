import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@sysmon/db/testing";
import { FakeAgent, makeFleet } from "@sysmon/fake-agent";
import { buildApp } from "../src/app.js";
import { hashToken } from "../src/tokens.js";

/** B5: sahte agent'lar gercek HTTP uzerinden gercek API'ye ve gercek TimescaleDB'ye konusur. */
let db: TestDb, app: FastifyInstance, port = 0, base = "";
const KEY = Buffer.alloc(32, 3);
const ROWS_PER_BATCH = 5 * 30;

const start = async () => {
  app = buildApp({ pool: db.pool, credentialKey: KEY,
    limits: { ingestPerDevice: 1_000_000, failedAuthPerIp: 1_000_000, enrollPerIp: 1_000_000, rotatePerDevice: 1_000_000 } });
  await app.listen({ port, host: "127.0.0.1" });
};

async function device(label: string) {
  const org = (await db.pool.query("INSERT INTO orgs (name) VALUES ($1) RETURNING id", [label])).rows[0].id;
  const id = (await db.pool.query("INSERT INTO devices (org_id, name) VALUES ($1,$2) RETURNING id", [org, label])).rows[0].id as string;
  const token = `tok_${label}_${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
  await db.pool.query("INSERT INTO device_tokens (token_hash, org_id, device_id) VALUES ($1,$2,$3)", [hashToken(token), org, id]);
  return { id, token };
}
const rows = async (id: string) => Number((await db.pool.query("SELECT count(*) FROM metric_samples WHERE device_id=$1", [id])).rows[0].count);
const agentFor = (token: string, extra: Partial<ConstructorParameters<typeof FakeAgent>[0]> = {}) => new FakeAgent({ baseUrl: base, token, ...extra });

beforeAll(async () => {
  db = await createTestDb();
  const probe = buildApp({ pool: db.pool, credentialKey: KEY });
  await probe.listen({ port: 0, host: "127.0.0.1" });
  port = (probe.server.address() as { port: number }).port;
  await probe.close();
  base = `http://127.0.0.1:${port}`;
  await start();
}, 120_000);
afterAll(async () => { await app?.close().catch(() => undefined); await db?.drop(); });

describe("sahte agent senaryolari (B5)", () => {
  it("normal akis: tum batch'ler onaylanir, satir sayisi tam, sunucunun ornekleme araligi ogrenilir", async () => {
    const d = await device("normal");
    const a = agentFor(d.token);
    a.enqueue(4);
    expect(await a.drain()).toBe("empty");
    expect(a.acked).toBe(4);
    expect(await rows(d.id)).toBe(4 * ROWS_PER_BATCH);
    expect(a.serverIntervalSeconds).toBe(5);
  });

  it("GERCEK kesinti: sunucu kapaninca kuyruk korunur (retry_later); donunce bosalir; kayip ve cift yok, seq bosluksuz", async () => {
    const d = await device("kesinti");
    const a = agentFor(d.token);
    a.enqueue(3);
    expect(await a.drain()).toBe("empty");

    await app.close(); // kesinti
    a.enqueue(12);
    expect(await a.drain()).toBe("retry_later");
    expect(a.queue).toHaveLength(12); // hicbiri silinmedi
    expect(a.statuses.get("hata")).toBeGreaterThan(0);

    await start(); // sunucu geri geldi
    expect(await a.drain()).toBe("empty");
    expect(await rows(d.id)).toBe(15 * ROWS_PER_BATCH);
    const st = (await db.pool.query("SELECT last_seq::int AS l FROM device_ingest_state WHERE device_id=$1", [d.id])).rows[0];
    expect(st.l).toBe(14); // seq 0..14 bosluksuz
  }, 60_000);

  it("replay: onaylanmis batch aynen tekrar gonderilince 200 doner ve satirlar CIFTLENMEZ", async () => {
    const d = await device("replay");
    const a = agentFor(d.token);
    a.enqueue(2);
    await a.drain();
    const before = await rows(d.id);
    expect(await a.replayLastAcked()).toBe(200);
    expect(await a.replayLastAcked()).toBe(200);
    expect(await rows(d.id)).toBe(before);
  });

  it("zehirli batch: 10 kalici 4xx sonrasi atilir, sonraki batch'ler akar (kuyruk tikanmaz)", async () => {
    const d = await device("zehir");
    const a = agentFor(d.token);
    a.enqueue(1);
    a.enqueuePoison();
    a.enqueue(2);
    expect(await a.drain()).toBe("empty");
    expect(a.dropped).toBe(1);
    expect(a.acked).toBe(3);
    expect(a.statuses.get(400)).toBe(10);
    expect(await rows(d.id)).toBe(3 * ROWS_PER_BATCH);
  });

  it("epoch sifirlama: yeni epoch seq 0'dan kabul edilir; eski epoch'lu bekleyenler kendi epoch'lariyla gider", async () => {
    const d = await device("epoch");
    const a = agentFor(d.token);
    a.enqueue(2);          // epoch 1: seq 0,1 (henuz gonderilmedi)
    a.resetEpoch();
    a.enqueue(2);          // epoch 2: seq 0,1
    expect(await a.drain()).toBe("empty");
    expect(a.acked).toBe(4);
    const e = (await db.pool.query("SELECT count(*)::int AS n FROM device_ingest_state WHERE device_id=$1", [d.id])).rows[0].n;
    expect(e).toBe(2);
    expect(await rows(d.id)).toBe(4 * ROWS_PER_BATCH);
  });

  it("saat sapmasi: agent'in saati 10 dk geri ise 409 + server_time ile ofset ogrenir ve yine de teslim eder", async () => {
    const d = await device("saat");
    const a = agentFor(d.token, { now: () => new Date(Date.now() - 10 * 60_000) });
    a.enqueue(2);
    expect(await a.drain()).toBe("empty");
    expect(a.statuses.get(409)).toBeGreaterThanOrEqual(1);
    expect(a.acked).toBe(2);
    expect(Math.abs(a.clockOffsetMs - 10 * 60_000)).toBeLessThan(5_000);
  });

  it("iptal edilmis token: 401, kuyruk KORUNUR (agent veriyi atmaz)", async () => {
    const d = await device("iptal");
    await db.pool.query("UPDATE device_tokens SET revoked_at=now() WHERE device_id=$1", [d.id]);
    const a = agentFor(d.token);
    a.enqueue(3);
    expect(await a.drain()).toBe("auth_failed");
    expect(a.queue).toHaveLength(3);
    expect(await rows(d.id)).toBe(0);
  });

  it("TOPLU YENIDEN BAGLANMA FIRTINASI: 100 cihaz ayni anda biriken batch'lerini bosaltir; hata yok, kayip yok", async () => {
    const N = 100, B = 8;
    const devs = [];
    for (let i = 0; i < N; i++) devs.push(await device(`firtina${i}`));
    const fleet = makeFleet({ baseUrl: base, devices: devs });
    fleet.forEach((a) => a.enqueue(B)); // kesinti boyunca birikenler
    const t0 = Date.now();
    const results = await Promise.all(fleet.map((a) => a.drain()));
    const sec = (Date.now() - t0) / 1000;
    console.log(`firtina: ${N} cihaz x ${B} batch = ${N * B} istek, ${sec.toFixed(1)} sn, ${(N * B / sec).toFixed(0)} istek/sn`);

    expect(results.every((r) => r === "empty")).toBe(true);
    const bad = fleet.flatMap((a) => [...a.statuses.entries()]).filter(([s]) => s !== 200);
    expect(bad).toEqual([]);
    const total = Number((await db.pool.query("SELECT count(*) FROM metric_samples WHERE device_id = ANY($1)", [devs.map((d) => d.id)])).rows[0].count);
    expect(total).toBe(N * B * ROWS_PER_BATCH);
    expect(sec).toBeLessThan(90);
  }, 180_000);
});

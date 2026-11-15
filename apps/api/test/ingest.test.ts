import { gzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@sysmon/db/testing";
import { buildApp } from "../src/app.js";
import { hashToken } from "../src/tokens.js";

let db: TestDb;
let app: FastifyInstance;
let now = new Date("2026-11-12T12:00:00Z");

interface Dev { org: string; id: string; token: string }
let A: Dev, B: Dev;

async function mkDevice(name: string): Promise<Dev> {
  const org = (await db.pool.query("INSERT INTO orgs (name) VALUES ($1) RETURNING id", [name])).rows[0].id as string;
  const id = (await db.pool.query("INSERT INTO devices (org_id, name) VALUES ($1,$2) RETURNING id", [org, name])).rows[0].id as string;
  const token = `tok_${randomUUID()}${randomUUID()}`.replaceAll("-", "");
  await db.pool.query("INSERT INTO device_tokens (token_hash, org_id, device_id) VALUES ($1,$2,$3)", [hashToken(token), org, id]);
  return { org, id, token };
}

beforeAll(async () => {
  db = await createTestDb();
  app = buildApp({ pool: db.pool, now: () => now, credentialKey: Buffer.alloc(32, 1) });
  await app.ready();
  A = await mkDevice("orgA");
  B = await mkDevice("orgB");
}, 120_000);
afterAll(async () => {
  await app?.close();
  await db?.drop();
});
beforeEach(() => {
  now = new Date("2026-11-12T12:00:00Z");
});

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const T0 = () => iso(new Date(now.getTime() - 5_000));

function body(over: Record<string, unknown> = {}, epoch = "11111111-1111-4111-8111-111111111111", seq = 0) {
  return {
    v: 1,
    spool_epoch: epoch,
    seq,
    sent_at: iso(now),
    samples: [{ ts: T0(), m: { "cpu.total": 12.5, "mem.used_pct": 40, "gpu.temp": null } }],
    ...over,
  };
}

async function post(payload: unknown, token: string | null = A.token, opts: { gzip?: boolean; raw?: Buffer; headers?: Record<string, string> } = {}) {
  const raw = opts.raw ?? Buffer.from(JSON.stringify(payload));
  const gz = opts.gzip ?? true;
  return app.inject({
    method: "POST",
    url: "/agent/v1/ingest",
    headers: {
      "content-type": "application/json",
      ...(gz ? { "content-encoding": "gzip" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    },
    payload: gz && !opts.raw ? gzipSync(raw) : raw,
  });
}

const count = async (dev: Dev, metric?: string) =>
  Number((await db.pool.query("SELECT count(*) FROM metric_samples WHERE device_id=$1 AND ($2::text IS NULL OR metric=$2)", [dev.id, metric ?? null])).rows[0].count);
const reset = () => db.pool.query("TRUNCATE metric_samples, device_ingest_state");

describe("kimlik dogrulama", () => {
  beforeEach(reset);

  it("Authorization yoksa 401", async () => {
    expect((await post(body(), null)).statusCode).toBe(401);
  });
  it("bilinmeyen token 401 ve hicbir veri yazilmaz", async () => {
    expect((await post(body(), "tok_yok")).statusCode).toBe(401);
    expect(await count(A)).toBe(0);
  });
  it("Bearer olmayan sema 401", async () => {
    const r = await post(body(), null, { headers: { authorization: `Basic ${A.token}` } });
    expect(r.statusCode).toBe(401);
  });
  it("iptal edilen token 401", async () => {
    const d = await mkDevice("rev");
    await db.pool.query("UPDATE device_tokens SET revoked_at=now() WHERE device_id=$1", [d.id]);
    expect((await post(body(), d.token)).statusCode).toBe(401);
  });
  it("suresi dolan token 401", async () => {
    const d = await mkDevice("exp");
    await db.pool.query("UPDATE device_tokens SET expires_at=$2 WHERE device_id=$1", [d.id, new Date(now.getTime() - 60_000)]);
    expect((await post(body(), d.token)).statusCode).toBe(401);
  });
  it("iptal edilmis CIHAZIN gecerli token'i da 401", async () => {
    const d = await mkDevice("revdev");
    await db.pool.query("UPDATE devices SET revoked_at=now() WHERE id=$1", [d.id]);
    expect((await post(body(), d.token)).statusCode).toBe(401);
  });
  it("tekduze hata govdesi: yanit token'in neden reddedildigini sizdirmaz", async () => {
    const a = await post(body(), "tok_yok");
    const d = await mkDevice("rev2");
    await db.pool.query("UPDATE device_tokens SET revoked_at=now() WHERE device_id=$1", [d.id]);
    const b = await post(body(), d.token);
    expect(a.json()).toEqual(b.json());
  });
});

describe("basarili alim", () => {
  beforeEach(reset);

  it("200: ack_seq = seq, orneklerin metrikleri satirlar olarak yazilir, NULL korunur, server_time doner", async () => {
    const r = await post(body({}, undefined, 7));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ack_seq: 7, rejected: 0, server_time: iso(now) });
    expect(await count(A)).toBe(3);
    const nul = await db.pool.query("SELECT value FROM metric_samples WHERE device_id=$1 AND metric='gpu.temp'", [A.id]);
    expect(nul.rows[0].value).toBeNull();
    const row = (await db.pool.query("SELECT org_id FROM metric_samples WHERE device_id=$1 LIMIT 1", [A.id])).rows[0];
    expect(row.org_id).toBe(A.org);
  });

  it("gzip'siz duz JSON da kabul edilir", async () => {
    expect((await post(body(), A.token, { gzip: false })).statusCode).toBe(200);
  });

  it("last_seen_at guncellenir", async () => {
    await post(body());
    const r = await db.pool.query("SELECT last_seen_at FROM devices WHERE id=$1", [A.id]);
    expect(r.rows[0].last_seen_at).not.toBeNull();
  });

  it("bos samples dizisi gecerlidir ve ack ilerler", async () => {
    const r = await post(body({ samples: [] }, undefined, 3));
    expect(r.json()).toMatchObject({ ack_seq: 3, rejected: 0 });
  });
});

describe("idempotency ve sequence", () => {
  beforeEach(reset);

  it("replay: ayni batch tekrar gelirse 200, ack_seq doner ve satirlar CIFTLENMEZ", async () => {
    const p = body({}, undefined, 4);
    await post(p);
    const again = await post(p);
    expect(again.statusCode).toBe(200);
    expect(again.json().ack_seq).toBe(4);
    expect(await count(A)).toBe(3);
  });

  it("eski seq (zaten islenmis) tekrarinda ack_seq son islenen seq'tir (>= gonderilen)", async () => {
    await post(body({}, undefined, 10));
    const r = await post(body({}, undefined, 6));
    expect(r.statusCode).toBe(200);
    expect(r.json().ack_seq).toBe(10);
  });

  it("seq bosluklari kabul edilir (agent spool tasmasinda eski batch'leri atar)", async () => {
    await post(body({}, undefined, 0));
    const r = await post(body({}, undefined, 50));
    expect(r.statusCode).toBe(200);
    expect(r.json().ack_seq).toBe(50);
  });

  it("yeni spool_epoch seq 0'dan baslar ve kabul edilir; eski epoch kendi sayaciyla devam eder", async () => {
    const E1 = "11111111-1111-4111-8111-111111111111";
    const E2 = "22222222-2222-4222-8222-222222222222";
    await post(body({ samples: [{ ts: T0(), m: { "a.x": 1 } }] }, E1, 5));
    const n = await post(body({ samples: [{ ts: T0(), m: { "a.y": 2 } }] }, E2, 0));
    expect(n.json().ack_seq).toBe(0);
    const old = await post(body({ samples: [{ ts: T0(), m: { "a.z": 3 } }] }, E1, 6)); // eski epoch artigi
    expect(old.json().ack_seq).toBe(6);
    const dup = await post(body({ samples: [{ ts: T0(), m: { "a.x": 9 } }] }, E1, 5)); // eski epoch tekrari
    expect(dup.json().ack_seq).toBe(6);
    expect(await count(A, "a.x")).toBe(1);
    expect(await count(A, "a.y")).toBe(1);
    expect(await count(A, "a.z")).toBe(1);
  });

  it("EszAMANLI ayni batch: tam bir kez yazilir, hepsi 200", async () => {
    const p = body({}, "33333333-3333-4333-8333-333333333333", 1);
    const rs = await Promise.all(Array.from({ length: 8 }, () => post(p)));
    expect(rs.map((r) => r.statusCode)).toEqual(Array(8).fill(200));
    expect(await count(A)).toBe(3);
  });
});

describe("dogrulama ve sinirlar", () => {
  beforeEach(reset);

  it("govdede device_id -> 400 ve hicbir veri yazilmaz (N1)", async () => {
    const r = await post({ ...body(), device_id: A.id });
    expect(r.statusCode).toBe(400);
    expect(await count(A)).toBe(0);
  });

  it("govdede BASKA cihazin device_id'si -> 400 ve B'nin verisi degismez (N1 negatif)", async () => {
    const before = await count(B);
    const r = await post({ ...body(), device_id: B.id });
    expect(r.statusCode).toBe(400);
    expect(await count(B)).toBe(before);
    expect(await count(A)).toBe(0);
  });

  it("A'nin token'i yalnizca A'nin satirlarini yazar (cihaz yalniz token'dan cozulur)", async () => {
    await post(body());
    expect(await count(B)).toBe(0);
    expect((await db.pool.query("SELECT DISTINCT org_id FROM metric_samples")).rows).toEqual([{ org_id: A.org }]);
  });

  it("gecersiz JSON 400", async () => {
    expect((await post(null, A.token, { raw: gzipSync(Buffer.from("{bozuk")) })).statusCode).toBe(400);
  });

  it("gecersiz gzip 400", async () => {
    expect((await post(null, A.token, { raw: Buffer.from("bu gzip degil"), gzip: true })).statusCode).toBe(400);
  });

  it("v != 1 -> 400; eksik alan -> 400; yanlis tip -> 400", async () => {
    expect((await post(body({ v: 2 }))).statusCode).toBe(400);
    expect((await post(body({ seq: undefined }))).statusCode).toBe(400);
    expect((await post(body({ seq: "1" }))).statusCode).toBe(400);
    expect((await post(body({ spool_epoch: "uuid-degil" }))).statusCode).toBe(400);
    expect((await post(body({ seq: -1 }))).statusCode).toBe(400);
  });

  it("1000'den fazla ornek 400", async () => {
    const samples = Array.from({ length: 1001 }, () => ({ ts: T0(), m: { "a.b": 1 } }));
    expect((await post(body({ samples }))).statusCode).toBe(400);
  });

  it("metrik degeri sayi/null disinda ise 400", async () => {
    expect((await post(body({ samples: [{ ts: T0(), m: { "a.b": "x" } }] }))).statusCode).toBe(400);
  });

  it("gzip bomb: acilmis boyut > 10 MB -> 413, veri yazilmaz", async () => {
    const bomb = gzipSync(Buffer.alloc(30 * 1024 * 1024, 0x20)); // ~30 MB bosluk, kucuk sikistirilmis
    expect(bomb.length).toBeLessThan(1024 * 1024);
    const r = await post(null, A.token, { raw: bomb });
    expect(r.statusCode).toBe(413);
    expect(await count(A)).toBe(0);
  });

  it("sikistirilmis govde > 1 MB -> 413", async () => {
    const r = await post(null, A.token, { raw: Buffer.alloc(1024 * 1024 + 10, 1), gzip: true });
    expect(r.statusCode).toBe(413);
  });

  it("bilinmeyen Content-Encoding 415", async () => {
    const r = await app.inject({
      method: "POST", url: "/agent/v1/ingest",
      headers: { "content-type": "application/json", "content-encoding": "br", authorization: `Bearer ${A.token}` },
      payload: Buffer.from("{}"),
    });
    expect(r.statusCode).toBe(415);
  });
});

describe("zaman damgasi sinirlari", () => {
  beforeEach(reset);

  it("sent_at sunucu saatinden 5 dk'dan fazla saparsa 409 + server_time; veri yazilmaz", async () => {
    const r = await post(body({ sent_at: iso(new Date(now.getTime() - 6 * 60_000)) }));
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ server_time: iso(now) });
    expect(await count(A)).toBe(0);
    expect((await post(body({ sent_at: iso(new Date(now.getTime() + 6 * 60_000)) }))).statusCode).toBe(409);
  });

  it("sent_at ±5 dk icindeyse kabul edilir", async () => {
    expect((await post(body({ sent_at: iso(new Date(now.getTime() - 4 * 60_000)) }))).statusCode).toBe(200);
  });

  it("24 saatten eski ve 2 dk'dan ileri ornekler KALICI reddedilir (rejected sayilir), ack ilerler", async () => {
    const samples = [
      { ts: iso(new Date(now.getTime() - 25 * 3600_000)), m: { "a.old": 1 } },
      { ts: iso(new Date(now.getTime() + 3 * 60_000)), m: { "a.future": 1 } },
      { ts: iso(new Date(now.getTime() - 3 * 3600_000)), m: { "a.ok": 1 } },
    ];
    const r = await post(body({ samples }, undefined, 2));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ack_seq: 2, rejected: 2 });
    expect(await count(A, "a.ok")).toBe(1);
    expect(await count(A, "a.old")).toBe(0);
    expect(await count(A, "a.future")).toBe(0);
  });

  // M-1 (inceleme "kalici 500" demisti; OLCULDU: Zod takvim-gecersiz tarihi zaten reddeder -> 400, 500 YOK). Bu testler davranisi kilitler:
  // 5xx olsaydi agent batch'i hic atmazdi; 4xx ise zehirli-batch sayaciyla atilir (agent gecersiz tarih uretmez).
  it("takvimde olmayan ornek tarihi 5xx vermez: 400, hicbir veri yazilmaz", async () => {
    const samples = [
      { ts: "2026-02-31T10:00:00Z", m: { "a.bad": 1 } },
      { ts: iso(new Date(now.getTime() - 3600_000)), m: { "a.ok": 1 } },
    ];
    const r = await post(body({ samples }, undefined, 4));
    expect(r.statusCode).toBe(400);
    expect(await count(A)).toBe(0);
  });

  it("takvimde olmayan sent_at 400 (gecici hata degil)", async () => {
    const r = await post(body({ sent_at: "2026-02-31T10:00:00Z" }));
    expect(r.statusCode).toBe(400);
    expect(await count(A)).toBe(0);
  });
});

describe("metrik adi", () => {
  beforeEach(reset);

  it("kotu metrik adi yalniz o girdiyi reddeder (rejected), digerleri yazilir, ack ilerler", async () => {
    const m = { "cpu.total": 1, "BOZUK AD": 2, ["x".repeat(70) + ".y"]: 3, "tek": 4 };
    const r = await post(body({ samples: [{ ts: T0(), m }] }, undefined, 9));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ack_seq: 9, rejected: 3 });
    expect(await count(A)).toBe(1);
  });

  it("bir ornekte cok fazla metrik (>256) 400", async () => {
    const m = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`a.m${i}`, i]));
    expect((await post(body({ samples: [{ ts: T0(), m }] }))).statusCode).toBe(400);
  });
});

describe("istek goruntuleri", () => {
  it("bilinmeyen yol 404", async () => {
    expect((await app.inject({ method: "GET", url: "/yok" })).statusCode).toBe(404);
  });
  it("GET /agent/v1/ingest izinli degil", async () => {
    const r = await app.inject({ method: "GET", url: "/agent/v1/ingest" });
    expect([404, 405]).toContain(r.statusCode);
  });
});

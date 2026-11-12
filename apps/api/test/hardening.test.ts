import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEnrollmentToken } from "../src/enrollment.js";
import { enrollBody, iso, ping, post, setupKit, type Kit } from "./kit.js";

/** Bagimsiz inceleme I-5: kritik yollardaki test bosluklari (rotation yarislari, sikistirilmis chunk'a GERCEK ingest yolu). */
let k: Kit;
let n = 0;
beforeAll(async () => { k = await setupKit(); }, 120_000);
afterAll(async () => { await k?.close(); });

async function enrolled() {
  const t = await createEnrollmentToken(k.db.pool, k.org, { now: k.clock.now });
  const r = await post(k, "/agent/v1/enroll", enrollBody(t, { enroll_id: `e1000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, machine_guid: `gh-${n}` }));
  expect(r.statusCode).toBe(200);
  return r.json() as { device_id: string; credential: string };
}
const rotate = (token: string, id: string) => post(k, "/agent/v1/rotate", { rotation_id: id }, token);
const rid = (i: number) => `d1000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const tokenRows = async (dev: string) => Number((await k.db.pool.query("SELECT count(*) FROM device_tokens WHERE device_id=$1", [dev])).rows[0].count);

describe("rotation yarislari", () => {
  it("ESZAMANLI farkli rotation_id'ler: tam bir rotation kazanir, digerleri 409; tek yeni token olusur", async () => {
    const d = await enrolled();
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => rotate(d.credential, rid(100 + i))));
    const codes = rs.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 409, 409, 409, 409, 409]);
    expect(await tokenRows(d.device_id)).toBe(2);
  });

  it("ESZAMANLI ayni rotation_id: hepsi 200 ve AYNI credential; tek yeni token", async () => {
    const d = await enrolled();
    const rs = await Promise.all(Array.from({ length: 6 }, () => rotate(d.credential, rid(200))));
    expect(rs.map((r) => r.statusCode)).toEqual(Array(6).fill(200));
    expect(new Set(rs.map((r) => r.json().credential)).size).toBe(1);
    expect(await tokenRows(d.device_id)).toBe(2);
  });

  it("yeniden kullanim tespiti ESZAMANLI eski-token isteklerinde tutarli: hepsi 401, iki token da iptal, cihaz isaretli", async () => {
    const d = await enrolled();
    const fresh = (await rotate(d.credential, rid(300))).json().credential as string;
    expect((await ping(k, fresh)).statusCode).toBe(200); // yeni token ilk kullanildi

    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => ping(k, d.credential, 10 + i)));
    expect(rs.map((r) => r.statusCode)).toEqual(Array(6).fill(401));

    const revoked = (await k.db.pool.query("SELECT count(*)::int n FROM device_tokens WHERE device_id=$1 AND revoked_at IS NOT NULL", [d.device_id])).rows[0].n;
    expect(revoked).toBe(2);
    expect((await k.db.pool.query("SELECT compromised_at FROM devices WHERE id=$1", [d.device_id])).rows[0].compromised_at).not.toBeNull();
    const audits = (await k.db.pool.query("SELECT count(*)::int n FROM audit_events WHERE device_id=$1 AND kind='credential_reuse'", [d.device_id])).rows[0].n;
    expect(audits).toBeGreaterThanOrEqual(1);
    expect((await ping(k, fresh, 99)).statusCode).toBe(401); // yeni token da artik gecersiz
  });
});

describe("SIKISTIRILMIS chunk'a gercek ingest yolu (HTTP, toplu unnest + ON CONFLICT)", () => {
  const T = new Date("2026-11-11T18:00:00Z"); // injected saatten (2026-11-12T12:00Z) 18 sa once: 24 sa penceresinde, 12 sa sikistirma esiginden eski
  const send = (token: string, seq: number, samples: { ts: Date; m: Record<string, number | null> }[]) =>
    k.app.inject({ method: "POST", url: "/agent/v1/ingest",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      payload: JSON.stringify({ v: 1, spool_epoch: "22222222-2222-4222-8222-222222222222", seq, sent_at: iso(k.clock.now),
        samples: samples.map((s) => ({ ts: iso(s.ts), m: s.m })) }) });
  const at = (s: number) => new Date(T.getTime() + s * 1000);
  const rows = async (dev: string) => Number((await k.db.pool.query("SELECT count(*) FROM metric_samples WHERE device_id=$1", [dev])).rows[0].count);

  it("replay, yinelenen anahtar ve yeni satir sikistirilmis chunk'ta dogru isler; agrega gec veriyi alir", async () => {
    const d = await enrolled();
    expect((await send(d.credential, 0, [{ ts: at(0), m: { "a.x": 1, "a.y": 2 } }, { ts: at(1), m: { "a.x": 3, "a.y": null } }])).statusCode).toBe(200);
    expect(await rows(d.device_id)).toBe(4);

    for (const c of (await k.db.pool.query("SELECT show_chunks('metric_samples') c")).rows)
      await k.db.pool.query("SELECT compress_chunk($1::regclass, if_not_compressed => true)", [c.c]);
    const cmp = (await k.db.pool.query("SELECT count(*)::int n FROM timescaledb_information.chunks WHERE hypertable_name='metric_samples' AND is_compressed")).rows[0].n;
    expect(cmp).toBeGreaterThan(0); // gercekten sikistirilmis chunk'a yaziliyor

    // (a) replay (ayni seq): 200, satir sayisi degismez
    expect((await send(d.credential, 0, [{ ts: at(0), m: { "a.x": 1, "a.y": 2 } }, { ts: at(1), m: { "a.x": 3, "a.y": null } }])).statusCode).toBe(200);
    expect(await rows(d.device_id)).toBe(4);

    // (b) YENI seq: at(0)/a.x GERCEK yinelenen (deger farkli: atlanmali), a.z yeni, at(10)/a.x yeni satir
    expect((await send(d.credential, 1, [{ ts: at(0), m: { "a.x": 999, "a.z": 5 } }, { ts: at(10), m: { "a.x": 6 } }])).statusCode).toBe(200);
    expect(await rows(d.device_id)).toBe(6); // 4 + a.z@0 + a.x@10
    const dup = (await k.db.pool.query("SELECT value FROM metric_samples WHERE device_id=$1 AND metric='a.x' AND ts=$2", [d.device_id, at(0)])).rows[0];
    expect(dup.value).toBe(1); // yinelenen atlandi, ilk deger korundu

    // (c) agrega gec gelen sikistirilmis-chunk verisini yenileme penceresiyle alir
    await k.db.pool.query("CALL refresh_continuous_aggregate('metric_1m', $1::timestamptz, $2::timestamptz)", [at(-60), at(120)]);
    const agg = (await k.db.pool.query("SELECT sum(n)::int AS n FROM metric_1m WHERE device_id=$1", [d.device_id])).rows[0].n;
    const nonNull = (await k.db.pool.query("SELECT count(value)::int AS n FROM metric_samples WHERE device_id=$1", [d.device_id])).rows[0].n;
    expect(agg).toBe(nonNull);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EnrollResponseSchema } from "@sysmon/protocol";
import { createEnrollmentToken, purgeExpiredCredentials } from "../src/enrollment.js";
import { enrollBody, ping, post, setupKit, sha256, type Kit } from "./kit.js";

let k: Kit;
const PIN = "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

beforeAll(async () => { k = await setupKit({ spkiPins: [PIN] }); }, 120_000);
afterAll(async () => { await k?.close(); });

const newToken = (ttlMs?: number) => createEnrollmentToken(k.db.pool, k.org, { now: k.clock.now, ttlMs });
const enroll = (token: string, over: Record<string, unknown> = {}) => post(k, "/agent/v1/enroll", enrollBody(token, over));
const devicesCount = async () => Number((await k.db.pool.query("SELECT count(*) FROM devices WHERE org_id=$1", [k.org])).rows[0].count);

describe("enrollment (B2)", () => {
  it("basari: 200, yanit semasina uyar, cihaz organizasyonla olusur, SPKI pin yankilanir", async () => {
    const t = await newToken();
    const r = await enroll(t, { enroll_id: "b0000000-0000-4000-8000-000000000001", machine_guid: "g-happy" });
    expect(r.statusCode).toBe(200);
    const res = EnrollResponseSchema.parse(r.json());
    expect(res.spki_pins).toEqual([PIN]);
    const d = (await k.db.pool.query("SELECT org_id, name, device_info FROM devices WHERE id=$1", [res.device_id])).rows[0];
    expect(d.org_id).toBe(k.org);
    expect(d.name).toBe("PC-01");
    expect(d.device_info.hostname).toBe("PC-01");
  });

  it("verilen credential ingest'te calisir (token ozeti device_tokens'a kayitli)", async () => {
    const r = await enroll(await newToken(), { enroll_id: "b0000000-0000-4000-8000-000000000002", machine_guid: "g-ingest" });
    const { credential } = r.json();
    expect((await ping(k, credential)).statusCode).toBe(200);
  });

  it("ham credential veritabaninda DUZ METIN olarak bulunmaz; yalniz ozet + sifreli kopya", async () => {
    const r = await enroll(await newToken(), { enroll_id: "b0000000-0000-4000-8000-000000000003", machine_guid: "g-hash" });
    const { credential, device_id } = r.json();
    const tok = (await k.db.pool.query("SELECT token_hash FROM device_tokens WHERE device_id=$1", [device_id])).rows[0];
    expect(Buffer.compare(tok.token_hash, sha256(credential))).toBe(0);
    const enc = (await k.db.pool.query("SELECT credential_enc FROM enrollments WHERE device_id=$1", [device_id])).rows[0].credential_enc as Buffer;
    expect(enc).not.toBeNull();
    expect(enc.includes(Buffer.from(credential))).toBe(false); // sifreli: duz metin icermez
  });

  it("enrollment token TEK KULLANIMLIK: ikinci kullanim (farkli enroll_id) 401", async () => {
    const t = await newToken();
    expect((await enroll(t, { enroll_id: "b0000000-0000-4000-8000-000000000004", machine_guid: "g-a" })).statusCode).toBe(200);
    expect((await enroll(t, { enroll_id: "b0000000-0000-4000-8000-000000000005", machine_guid: "g-b" })).statusCode).toBe(401);
  });

  it("suresi dolan token 401 (varsayilan gecerlilik 1 saat)", async () => {
    const t = await newToken();
    k.clock.now = new Date(k.clock.now.getTime() + 61 * 60_000);
    try {
      expect((await enroll(t, { enroll_id: "b0000000-0000-4000-8000-000000000006" })).statusCode).toBe(401);
    } finally { k.clock.now = new Date("2026-11-12T12:00:00Z"); }
  });

  it("tekduze hata: bilinmeyen, kullanilmis ve suresi dolmus token ayni yaniti verir", async () => {
    const used = await newToken();
    await enroll(used, { enroll_id: "b0000000-0000-4000-8000-000000000007", machine_guid: "g-u" });
    const expired = await newToken(1000);
    k.clock.now = new Date(k.clock.now.getTime() + 5000);
    try {
      const a = await enroll("x".repeat(43), { enroll_id: "b0000000-0000-4000-8000-000000000008" });
      const b = await enroll(used, { enroll_id: "b0000000-0000-4000-8000-000000000009", machine_guid: "g-v" });
      const c = await enroll(expired, { enroll_id: "b0000000-0000-4000-8000-00000000000a" });
      expect([a.statusCode, b.statusCode, c.statusCode]).toEqual([401, 401, 401]);
      expect(b.json()).toEqual(a.json());
      expect(c.json()).toEqual(a.json());
    } finally { k.clock.now = new Date("2026-11-12T12:00:00Z"); }
  });

  it("KAYIP YANIT: ayni enroll_id + MachineGuid ile yeniden deneme 10 dk icinde AYNI credential'i dondurur, tek cihaz", async () => {
    const t = await newToken();
    const body = { enroll_id: "b0000000-0000-4000-8000-00000000000b", machine_guid: "g-retry" };
    const before = await devicesCount();
    const first = await enroll(t, body);
    const again = await enroll(t, body);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect(await devicesCount()).toBe(before + 1);
  });

  it("yeniden deneme ayni enroll_id ama FARKLI MachineGuid ile 401", async () => {
    const t = await newToken();
    await enroll(t, { enroll_id: "b0000000-0000-4000-8000-00000000000c", machine_guid: "g-orig" });
    expect((await enroll(t, { enroll_id: "b0000000-0000-4000-8000-00000000000c", machine_guid: "g-baska" })).statusCode).toBe(401);
  });

  it("10 dk sonra yeniden deneme reddedilir", async () => {
    const t = await newToken();
    const body = { enroll_id: "b0000000-0000-4000-8000-00000000000d", machine_guid: "g-late" };
    await enroll(t, body);
    k.clock.now = new Date(k.clock.now.getTime() + 11 * 60_000);
    try {
      expect((await enroll(t, body)).statusCode).toBe(401);
    } finally { k.clock.now = new Date("2026-11-12T12:00:00Z"); }
  });

  it("sifreli kopya sure sonunda SILINIR (purge), sonrasinda yeniden deneme 401", async () => {
    const t = await newToken();
    const body = { enroll_id: "b0000000-0000-4000-8000-00000000000e", machine_guid: "g-purge" };
    const first = await enroll(t, body);
    const dev = first.json().device_id;
    k.clock.now = new Date(k.clock.now.getTime() + 11 * 60_000);
    try {
      const n = await purgeExpiredCredentials(k.db.pool, k.clock.now);
      expect(n).toBeGreaterThanOrEqual(1);
      const row = (await k.db.pool.query("SELECT credential_enc FROM enrollments WHERE device_id=$1", [dev])).rows[0];
      expect(row.credential_enc).toBeNull();
      expect((await enroll(t, body)).statusCode).toBe(401);
    } finally { k.clock.now = new Date("2026-11-12T12:00:00Z"); }
  });

  it("ESZAMANLI cift kullanim: ayni token, farkli enroll_id -> tam bir basari, tek cihaz", async () => {
    const t = await newToken();
    const before = await devicesCount();
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      enroll(t, { enroll_id: `c0000000-0000-4000-8000-00000000000${i}`, machine_guid: `g-par-${i}` })));
    const ok = rs.filter((r) => r.statusCode === 200).length;
    expect(ok).toBe(1);
    expect(rs.filter((r) => r.statusCode === 401).length).toBe(5);
    expect(await devicesCount()).toBe(before + 1);
  });

  it("ESZAMANLI AYNI enroll_id (kayip yanit yarisi): hepsi 200 ve ayni credential, tek cihaz", async () => {
    const t = await newToken();
    const before = await devicesCount();
    const body = { enroll_id: "c1000000-0000-4000-8000-000000000001", machine_guid: "g-same" };
    const rs = await Promise.all(Array.from({ length: 6 }, () => enroll(t, body)));
    expect(rs.map((r) => r.statusCode)).toEqual(Array(6).fill(200));
    expect(new Set(rs.map((r) => r.json().credential)).size).toBe(1);
    expect(await devicesCount()).toBe(before + 1);
  });

  it("bilinmeyen alan veya kisa token -> 400 ve hicbir sey olusmaz", async () => {
    const before = await devicesCount();
    expect((await enroll(await newToken(), { extra: 1 })).statusCode).toBe(400);
    expect((await enroll("kisa")).statusCode).toBe(400);
    expect(await devicesCount()).toBe(before);
  });

  it("token baska organizasyona ait cihaz uretemez: cihaz token'in organizasyonunda olusur", async () => {
    const org2 = (await k.db.pool.query("INSERT INTO orgs (name) VALUES ('o2') RETURNING id")).rows[0].id as string;
    const t = await createEnrollmentToken(k.db.pool, org2, { now: k.clock.now });
    const r = await enroll(t, { enroll_id: "b0000000-0000-4000-8000-00000000001f", machine_guid: "g-org2" });
    const d = (await k.db.pool.query("SELECT org_id FROM devices WHERE id=$1", [r.json().device_id])).rows[0];
    expect(d.org_id).toBe(org2);
  });
});

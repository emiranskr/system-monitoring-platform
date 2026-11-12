import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RotateResponseSchema } from "@sysmon/protocol";
import { createEnrollmentToken } from "../src/enrollment.js";
import { enrollBody, iso, ping, post, setupKit, type Kit } from "./kit.js";

let k: Kit;
const T0 = new Date("2026-11-12T12:00:00Z");
const R1 = "d0000000-0000-4000-8000-000000000001";
const R2 = "d0000000-0000-4000-8000-000000000002";
let n = 0;

beforeAll(async () => { k = await setupKit(); }, 120_000);
afterAll(async () => { await k?.close(); });
beforeEach(() => { k.clock.now = new Date(T0); });

/** Gercek enrollment akisiyla taze bir cihaz ve ilk credential'i uretir. */
async function enrolled() {
  const t = await createEnrollmentToken(k.db.pool, k.org, { now: k.clock.now });
  const id = `e0000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const r = await post(k, "/agent/v1/enroll", enrollBody(t, { enroll_id: id, machine_guid: `g-rot-${n}` }));
  expect(r.statusCode).toBe(200);
  return r.json() as { device_id: string; credential: string };
}
const rotate = (token: string, id = R1) => post(k, "/agent/v1/rotate", { rotation_id: id }, token);
const advance = (ms: number) => { k.clock.now = new Date(k.clock.now.getTime() + ms); };
const tokenRows = async (dev: string) => Number((await k.db.pool.query("SELECT count(*) FROM device_tokens WHERE device_id=$1", [dev])).rows[0].count);
const audit = async (dev: string) => (await k.db.pool.query("SELECT kind FROM audit_events WHERE device_id=$1 ORDER BY id", [dev])).rows.map((r) => r.kind as string);

describe("rotation (B4)", () => {
  it("200: yeni credential + 24 saatlik ust uste binme; yanit semasina uyar", async () => {
    const d = await enrolled();
    const r = await rotate(d.credential);
    expect(r.statusCode).toBe(200);
    const res = RotateResponseSchema.parse(r.json());
    expect(res.credential).not.toBe(d.credential);
    expect(res.overlap_expires_at).toBe(iso(new Date(T0.getTime() + 24 * 3600_000)));
  });

  it("yeni token ilk kullanilana kadar ESKI token calisir; yeni token da calisir", async () => {
    const d = await enrolled();
    const res = (await rotate(d.credential)).json();
    expect((await ping(k, d.credential)).statusCode).toBe(200); // eski hala gecerli
    expect((await ping(k, d.credential, 1)).statusCode).toBe(200);
    expect((await ping(k, res.credential, 2)).statusCode).toBe(200); // yeni
  });

  it("yeni token KULLANILDIKTAN sonra eski token sunulursa: 401, IKI token da iptal, cihaz isaretlenir, denetim olayi", async () => {
    const d = await enrolled();
    const res = (await rotate(d.credential)).json();
    expect((await ping(k, res.credential)).statusCode).toBe(200); // yeni ilk kez kullanildi

    expect((await ping(k, d.credential, 1)).statusCode).toBe(401); // eski sunuldu: yeniden kullanim

    expect((await ping(k, res.credential, 2)).statusCode).toBe(401); // yeni de iptal edildi
    const dev = (await k.db.pool.query("SELECT compromised_at FROM devices WHERE id=$1", [d.device_id])).rows[0];
    expect(dev.compromised_at).not.toBeNull();
    expect(await audit(d.device_id)).toContain("credential_reuse");
    const revoked = (await k.db.pool.query("SELECT count(*)::int AS n FROM device_tokens WHERE device_id=$1 AND revoked_at IS NOT NULL", [d.device_id])).rows[0].n;
    expect(revoked).toBe(2);
  });

  it("24 saat icinde yeni token HIC kullanilmazsa eski token duser (yeniden kullanim sayilmaz, yeni token saglam)", async () => {
    const d = await enrolled();
    const res = (await rotate(d.credential)).json();
    advance(25 * 3600_000);
    expect((await ping(k, d.credential)).statusCode).toBe(401);
    expect((await ping(k, res.credential)).statusCode).toBe(200);
    const dev = (await k.db.pool.query("SELECT compromised_at FROM devices WHERE id=$1", [d.device_id])).rows[0];
    expect(dev.compromised_at).toBeNull();
    expect(await audit(d.device_id)).not.toContain("credential_reuse");
  });

  it("ayni rotation_id AYNI credential'i dondurur (kayip yanit), tek yeni token satiri olusur", async () => {
    const d = await enrolled();
    const a = (await rotate(d.credential, R1)).json();
    const b = await rotate(d.credential, R1);
    expect(b.statusCode).toBe(200);
    expect(b.json().credential).toBe(a.credential);
    expect(b.json().overlap_expires_at).toBe(a.overlap_expires_at);
    expect(await tokenRows(d.device_id)).toBe(2);
  });

  it("bekleyen rotation varken FARKLI rotation_id reddedilir (409)", async () => {
    const d = await enrolled();
    await rotate(d.credential, R1);
    const r = await rotate(d.credential, R2);
    expect(r.statusCode).toBe(409);
    expect(await tokenRows(d.device_id)).toBe(2);
  });

  it("yeni token kullanilinca sifreli kopya silinir; ardindan yeni token yeni rotation baslatabilir", async () => {
    const d = await enrolled();
    const res = (await rotate(d.credential, R1)).json();
    await ping(k, res.credential);
    const enc = (await k.db.pool.query("SELECT credential_enc FROM device_tokens WHERE device_id=$1 AND first_used_at IS NOT NULL", [d.device_id])).rows[0];
    expect(enc.credential_enc).toBeNull();
    const again = await rotate(res.credential, R2);
    expect(again.statusCode).toBe(200);
    expect(again.json().credential).not.toBe(res.credential);
  });

  it("kimliksiz rotate 401; gecersiz govde 400; bilinmeyen alan 400", async () => {
    const d = await enrolled();
    expect((await post(k, "/agent/v1/rotate", { rotation_id: R1 })).statusCode).toBe(401);
    expect((await post(k, "/agent/v1/rotate", { rotation_id: "uuid-degil" }, d.credential)).statusCode).toBe(400);
    expect((await post(k, "/agent/v1/rotate", { rotation_id: R1, extra: 1 }, d.credential)).statusCode).toBe(400);
    expect(await tokenRows(d.device_id)).toBe(1);
  });

  it("yeni credential veritabaninda yalniz ozet + sifreli kopya olarak durur (duz metin yok)", async () => {
    const d = await enrolled();
    const res = (await rotate(d.credential)).json();
    const rows = (await k.db.pool.query("SELECT token_hash, credential_enc FROM device_tokens WHERE device_id=$1 AND credential_enc IS NOT NULL", [d.device_id])).rows;
    expect(rows).toHaveLength(1);
    expect((rows[0].credential_enc as Buffer).includes(Buffer.from(res.credential))).toBe(false);
    expect((rows[0].token_hash as Buffer).includes(Buffer.from(res.credential))).toBe(false);
  });

  it("baska cihazin rotation'i bu cihazin token'larini etkilemez", async () => {
    const d1 = await enrolled();
    const d2 = await enrolled();
    await rotate(d1.credential);
    expect((await ping(k, d2.credential)).statusCode).toBe(200);
    expect(await tokenRows(d2.device_id)).toBe(1);
  });
});

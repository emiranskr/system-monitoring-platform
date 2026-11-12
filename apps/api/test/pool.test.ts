import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@sysmon/db/testing";
import { createPool } from "../src/pool.js";
import { connectGuarded, releaseGuarded } from "../src/db.js";

/** Inceleme I-3: pool.on("error") yoksa bosta bir baglantinin kopmasi yakalanmamis istisna olur ve sureci cokertir. */
let db: TestDb;
beforeAll(async () => { db = await createTestDb(); }, 120_000);
afterAll(async () => { await db?.drop(); });

describe("DB havuzu dayanikliligi", () => {
  it("bosta baglantinin arka ucu oldurulunce surec COKMEZ, hata bildirilir, havuz yeniden baglanir", async () => {
    const errors: Error[] = [];
    const pool = createPool(db.url, (e) => errors.push(e));
    await pool.query("SELECT 1"); // bosta bir istemci olustur

    const admin = new pg.Client({ connectionString: db.url });
    await admin.connect();
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND application_name = 'sysmon-api'");
    await admin.end();
    await new Promise((r) => setTimeout(r, 800));

    expect(errors.length).toBeGreaterThanOrEqual(1);           // isleyici cagrildi (yoksa vitest yakalanmamis istisnayla basarisiz olurdu)
    const r = await pool.query("SELECT 42 AS n");              // havuz yeniden baglandi
    expect(r.rows[0].n).toBe(42);
    await pool.end();
  });

  it("sorgu zaman asimi: uzun sorgu iptal edilir (DB takilirsa istekler sonsuza dek beklemez)", async () => {
    const pool = createPool(db.url, () => undefined, { statementTimeoutMs: 400 });
    await expect(pool.query("SELECT pg_sleep(5)")).rejects.toMatchObject({ code: "57014" });
    await pool.end();
  });

  it("baglanti zaman asimi: dolu havuzda yeni istek sonsuza dek kuyrukta beklemez", async () => {
    const pool = createPool(db.url, () => undefined, { max: 1, connectionTimeoutMs: 300 });
    const held = await pool.connect();                          // tek baglanti tutuluyor
    await expect(pool.connect()).rejects.toThrow(/timeout/i);
    held.release();
    await pool.end();
  });

  it("islemde bosta kalan ODUNC ALINMIS istemci sunucuca kapatilinca surec COKMEZ (yakalanmamis olay yok), istemci havuzdan atilir", async () => {
    const pool = createPool(db.url, () => undefined, { idleInTransactionMs: 300 });
    const c = await connectGuarded(pool);
    await c.query("BEGIN");
    await new Promise((r) => setTimeout(r, 900));          // sunucu oturumu kapatir; istemci "error" yayar
    await expect(c.query("SELECT 1")).rejects.toBeTruthy(); // normal bir sorgu hatasi olarak yansir
    releaseGuarded(c);
    expect((await pool.query("SELECT 7 AS n")).rows[0].n).toBe(7); // havuz saglam
    await pool.end();
  });
});

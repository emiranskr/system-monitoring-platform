import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../src/testing.js";

/** M3a: kullanicilar, oturumlar, setup token'lari (0004). Gercek TimescaleDB/Postgres, gecici veritabani. */
let db: TestDb;
let orgA = "", orgB = "", userA = "";
const hash32 = () => Buffer.alloc(32, 7);

beforeAll(async () => {
  db = await createTestDb();
  orgA = (await db.pool.query("INSERT INTO orgs (name) VALUES ('a') RETURNING id")).rows[0].id;
  orgB = (await db.pool.query("INSERT INTO orgs (name) VALUES ('b') RETURNING id")).rows[0].id;
  userA = (await db.pool.query(
    "INSERT INTO users (org_id, email, password_hash, role) VALUES ($1,'Ali@Example.com','$argon2id$x','owner') RETURNING id", [orgA])).rows[0].id;
}, 120_000);

afterAll(async () => { await db?.drop(); });

describe("0004 kullanicilar ve oturumlar", () => {
  it("e-posta buyuk/kucuk harf duyarsiz TEKIL (ayni org veya baska org fark etmez)", async () => {
    await expect(db.pool.query("INSERT INTO users (org_id, email, password_hash, role) VALUES ($1,'ali@example.COM','h','viewer')", [orgA])).rejects.toThrow();
    await expect(db.pool.query("INSERT INTO users (org_id, email, password_hash, role) VALUES ($1,'ALI@example.com','h','viewer')", [orgB])).rejects.toThrow();
  });

  it("gecersiz rol reddedilir", async () => {
    await expect(db.pool.query("INSERT INTO users (org_id, email, password_hash, role) VALUES ($1,'x@y.z','h','root')", [orgA])).rejects.toThrow();
  });

  it("oturum baska organizasyonun kullanicisina baglanamaz (bilesik FK)", async () => {
    await expect(db.pool.query(
      "INSERT INTO sessions (id_hash, org_id, user_id, expires_at) VALUES ($1,$2,$3, now() + interval '1 hour')", [hash32(), orgB, userA])).rejects.toThrow();
  });

  it("oturum ozeti 32 bayt olmali (ham kimlik saklanmaz)", async () => {
    await expect(db.pool.query(
      "INSERT INTO sessions (id_hash, org_id, user_id, expires_at) VALUES ($1,$2,$3, now() + interval '1 hour')", [Buffer.from("ham-kimlik"), orgA, userA])).rejects.toThrow();
  });

  it("kullanici silinince oturumlari da silinir", async () => {
    const u = (await db.pool.query("INSERT INTO users (org_id, email, password_hash, role) VALUES ($1,'sil@y.z','h','viewer') RETURNING id", [orgA])).rows[0].id;
    await db.pool.query("INSERT INTO sessions (id_hash, org_id, user_id, expires_at) VALUES ($1,$2,$3, now() + interval '1 hour')", [Buffer.alloc(32, 9), orgA, u]);
    await db.pool.query("DELETE FROM users WHERE id=$1", [u]);
    expect(Number((await db.pool.query("SELECT count(*) FROM sessions WHERE id_hash=$1", [Buffer.alloc(32, 9)])).rows[0].count)).toBe(0);
  });

  it("setup_tokens: ozet 32 bayt, ayni ozet iki kez eklenemez, used_at varsayilan bos", async () => {
    await db.pool.query("INSERT INTO setup_tokens (token_hash) VALUES ($1)", [hash32()]);
    await expect(db.pool.query("INSERT INTO setup_tokens (token_hash) VALUES ($1)", [hash32()])).rejects.toThrow();
    await expect(db.pool.query("INSERT INTO setup_tokens (token_hash) VALUES ($1)", [Buffer.from("kisa")])).rejects.toThrow();
    expect((await db.pool.query("SELECT used_at FROM setup_tokens")).rows[0].used_at).toBeNull();
  });
});

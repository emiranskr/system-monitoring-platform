import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate } from "./index.js";

/** Yerel gelistirme DB adresi: DATABASE_URL ortam degiskeni, yoksa deploy/.env (gitignore'lu). */
export function devDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envFile = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "deploy", ".env");
  if (existsSync(envFile)) {
    const m = /^DATABASE_URL=(.+)$/m.exec(readFileSync(envFile, "utf8"));
    if (m?.[1]) return m[1].trim();
  }
  throw new Error("DATABASE_URL tanimli degil ve deploy/.env bulunamadi (docker compose DB'sini baslatin).");
}

export interface TestDb {
  pool: pg.Pool;
  url: string;
  drop(): Promise<void>;
}

/**
 * GERCEK Docker TimescaleDB uzerinde her cagri icin gecici bir veritabani olusturur ve migrate eder (sahte DB yok).
 * Mevcut gelistirme verisine dokunmaz; drop() gecici veritabanini siler.
 */
export async function createTestDb(opts: { migrate?: boolean } = {}): Promise<TestDb> {
  const base = new URL(devDatabaseUrl());
  const name = `sysmon_t_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: base.toString() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(base);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 10 });
  pool.on("error", () => undefined); // test duzeni: bosta baglanti kopmasi (ornegin DROP DATABASE WITH FORCE) sureci dusurmesin
  if (opts.migrate !== false) await migrate(pool);

  return {
    pool,
    url: url.toString(),
    async drop() {
      await pool.end();
      const a = new pg.Client({ connectionString: base.toString() });
      await a.connect();
      try {
        await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await a.end();
      }
    },
  };
}

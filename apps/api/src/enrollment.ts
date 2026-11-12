import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { EnrollRequestSchema, type EnrollResponse } from "@sysmon/protocol";
import { encrypt, decrypt, newCredential } from "./crypto.js";
import { badRequest, unauthorized } from "./errors.js";
import { rateLimited, type Limiters } from "./ratelimit.js";
import { hashToken } from "./tokens.js";
import { createHash } from "node:crypto";

export const ENROLL_TOKEN_TTL_MS = 60 * 60_000; // varsayilan gecerlilik: 1 saat
export const ENROLL_RETRY_WINDOW_MS = 10 * 60_000; // kayip yanit sonrasi yeniden deneme penceresi

/** Yonetici islemi (panel/CLI M3'te bunu cagirir): tek kullanimlik enrollment token'i. Yalnizca ozeti saklanir. */
export async function createEnrollmentToken(
  pool: pg.Pool, orgId: string, opts: { now?: Date; ttlMs?: number } = {},
): Promise<string> {
  const now = opts.now ?? new Date();
  const token = randomBytes(32).toString("base64url");
  await pool.query("INSERT INTO enrollment_tokens (token_hash, org_id, created_at, expires_at) VALUES ($1,$2,$3,$4)", [
    hashToken(token), orgId, now, new Date(now.getTime() + (opts.ttlMs ?? ENROLL_TOKEN_TTL_MS)),
  ]);
  return token;
}

/** Sureleri dolan sifreli credential kopyalarini siler (enrollment 10 dk, rotation ust uste binme sonu). Silinen sayisini doner. */
export async function purgeExpiredCredentials(pool: pg.Pool, now: Date = new Date()): Promise<number> {
  const a = await pool.query("UPDATE enrollments SET credential_enc=NULL WHERE credential_enc IS NOT NULL AND retry_expires_at <= $1", [now]);
  const b = await pool.query(
    `UPDATE device_tokens s SET credential_enc=NULL FROM device_tokens o
      WHERE o.superseded_by = s.token_hash AND o.overlap_expires_at <= $1 AND s.credential_enc IS NOT NULL`, [now]);
  return (a.rowCount ?? 0) + (b.rowCount ?? 0);
}

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest();

export function registerEnroll(app: FastifyInstance, pool: pg.Pool, now: () => Date, key: Buffer, spkiPins: string[], limiters: Limiters): void {
  app.post("/agent/v1/enroll", async (req, reply) => {
    // IP basina deneme siniri: gecerli token olsa bile asilirsa 429 (enrollment token'i tahmin denemelerini yavaslatir).
    if (!limiters.enrollPerIp.hit(req.ip)) throw rateLimited(limiters.enrollPerIp);
    let json: unknown;
    try { json = JSON.parse((req.body as Buffer).toString("utf8")); } catch { throw badRequest(); }
    const parsed = EnrollRequestSchema.safeParse(json);
    if (!parsed.success) throw badRequest();
    const b = parsed.data;
    const t = now();
    const machine = sha(b.machine_guid);

    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      // Token satirini KILITLE: ayni token ile eszamanli istekler siraya girer (tam bir basari).
      const tok = await c.query<{ org_id: string; expires_at: Date; used_at: Date | null }>(
        "SELECT org_id, expires_at, used_at FROM enrollment_tokens WHERE token_hash=$1 FOR UPDATE", [hashToken(b.token)]);
      const tr = tok.rows[0];
      if (!tr) { await c.query("ROLLBACK"); throw unauthorized(); }

      // Kayip yanit: ayni enroll_id + MachineGuid, pencere icinde -> ayni credential (kilit altinda yarissiz kontrol).
      const prev = await c.query<{ machine_guid_hash: Buffer; device_id: string; credential_enc: Buffer | null; retry_expires_at: Date }>(
        "SELECT machine_guid_hash, device_id, credential_enc, retry_expires_at FROM enrollments WHERE enroll_id=$1", [b.enroll_id]);
      const p = prev.rows[0];
      if (p) {
        await c.query("ROLLBACK");
        if (!p.machine_guid_hash.equals(machine) || !p.credential_enc || p.retry_expires_at <= t) throw unauthorized();
        return reply.send(<EnrollResponse>{ device_id: p.device_id, credential: decrypt(key, p.credential_enc), spki_pins: spkiPins });
      }

      if (tr.used_at || tr.expires_at <= t) { await c.query("ROLLBACK"); throw unauthorized(); }

      const credential = newCredential();
      const dev = await c.query<{ id: string }>(
        "INSERT INTO devices (org_id, name, machine_guid_hash, device_info) VALUES ($1,$2,$3,$4) RETURNING id",
        [tr.org_id, b.device_info.hostname, machine, JSON.stringify(b.device_info)]);
      const deviceId = dev.rows[0]!.id;
      await c.query("INSERT INTO device_tokens (token_hash, org_id, device_id) VALUES ($1,$2,$3)", [hashToken(credential), tr.org_id, deviceId]);
      await c.query("UPDATE enrollment_tokens SET used_at=$2, device_id=$3 WHERE token_hash=$1", [hashToken(b.token), t, deviceId]);
      await c.query(
        "INSERT INTO enrollments (enroll_id, machine_guid_hash, org_id, device_id, credential_enc, created_at, retry_expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [b.enroll_id, machine, tr.org_id, deviceId, encrypt(key, credential), t, new Date(t.getTime() + ENROLL_RETRY_WINDOW_MS)]);
      await c.query("INSERT INTO audit_events (ts, org_id, device_id, kind) VALUES ($1,$2,$3,'device_enrolled')", [t, tr.org_id, deviceId]);
      await c.query("COMMIT");
      return reply.send(<EnrollResponse>{ device_id: deviceId, credential, spki_pins: spkiPins });
    } catch (e) {
      try { await c.query("ROLLBACK"); } catch { /* zaten geri alinmis olabilir */ }
      throw e;
    } finally {
      c.release();
    }
  });
}

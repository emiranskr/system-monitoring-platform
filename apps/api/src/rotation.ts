import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { RotateRequestSchema, type RotateResponse } from "@sysmon/protocol";
import { authenticateGuarded } from "./auth.js";
import { rateLimited, type Limiters } from "./ratelimit.js";
import { decrypt, encrypt, newCredential } from "./crypto.js";
import { badRequest, HttpError } from "./errors.js";
import { hashToken } from "./tokens.js";

export const ROTATION_OVERLAP_MS = 24 * 3600_000;
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * POST /agent/v1/rotate {rotation_id}: idempotent. Mevcut token yerine yenisini uretir; eski token, yeni ilk kullanilana
 * kadar (en cok 24 saat) gecerli kalir. Ayni rotation_id ayni credential'i dondurur; bekleyen rotation varken farkli
 * rotation_id 409. Yeni credential ilk kullanilana kadar AES-GCM sifreli saklanir.
 */
export function registerRotate(app: FastifyInstance, pool: pg.Pool, now: () => Date, key: Buffer, limiters: Limiters): void {
  app.post("/agent/v1/rotate", {
    onRequest: async (req) => {
      req.auth = await authenticateGuarded(pool, req, now(), limiters.failedAuthPerIp);
      if (!limiters.rotatePerDevice.hit(req.auth.deviceId)) throw rateLimited(limiters.rotatePerDevice);
    },
    handler: async (req, reply) => {
      let json: unknown;
      try { json = JSON.parse((req.body as Buffer).toString("utf8")); } catch { throw badRequest(); }
      const parsed = RotateRequestSchema.safeParse(json);
      if (!parsed.success) throw badRequest();
      const rid = parsed.data.rotation_id;
      const auth = req.auth!;
      const t = now();

      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const cur = await c.query<{ superseded_by: Buffer | null; overlap_expires_at: Date | null; rotation_id: string | null }>(
          "SELECT superseded_by, overlap_expires_at, rotation_id FROM device_tokens WHERE token_hash=$1 FOR UPDATE", [auth.tokenHash]);
        const row = cur.rows[0]!;

        if (row.superseded_by) {
          // Eski token ust uste binme suresinde: ayni rotation_id -> ayni credential; farkli -> bekleyen rotation var.
          if (row.rotation_id !== rid) throw new HttpError(409, "rotation_pending");
          const succ = await c.query<{ credential_enc: Buffer | null }>("SELECT credential_enc FROM device_tokens WHERE token_hash=$1", [row.superseded_by]);
          const enc = succ.rows[0]?.credential_enc;
          if (!enc) throw new HttpError(409, "rotation_pending");
          await c.query("COMMIT");
          return reply.send(<RotateResponse>{ credential: decrypt(key, enc), overlap_expires_at: iso(row.overlap_expires_at!) });
        }

        const credential = newCredential();
        const newHash = hashToken(credential);
        const overlap = new Date(t.getTime() + ROTATION_OVERLAP_MS);
        await c.query("INSERT INTO device_tokens (token_hash, org_id, device_id, created_at, credential_enc) VALUES ($1,$2,$3,$4,$5)",
          [newHash, auth.orgId, auth.deviceId, t, encrypt(key, credential)]);
        await c.query("UPDATE device_tokens SET superseded_by=$2, overlap_expires_at=$3, rotation_id=$4 WHERE token_hash=$1",
          [auth.tokenHash, newHash, overlap, rid]);
        await c.query("INSERT INTO audit_events (ts, org_id, device_id, kind) VALUES ($1,$2,$3,'credential_rotated')", [t, auth.orgId, auth.deviceId]);
        await c.query("COMMIT");
        return reply.send(<RotateResponse>{ credential, overlap_expires_at: iso(overlap) });
      } catch (e) {
        try { await c.query("ROLLBACK"); } catch { /* zaten bitmis olabilir */ }
        throw e;
      } finally {
        c.release();
      }
    },
  });
}

import type pg from "pg";
import { connectGuarded, releaseGuarded } from "./db.js";
import { hashToken, parseBearer } from "./tokens.js";
import { HttpError, unauthorized } from "./errors.js";
import { ipKey, rateLimited, type RateLimiter } from "./ratelimit.js";

export interface AuthedDevice { orgId: string; deviceId: string; tokenHash: Buffer }

/**
 * IP basina basarisiz-kimlik-dogrulama sayaciyla korunmus dogrulama: basarisiz her deneme IP sayacini artirir, sinir
 * asildiktan sonra GECERSIZ istekler 429 alir; gecerli token'lar etkilenmez. IP, Fastify'in req.ip'sidir: trustProxy
 * KAPALIYKEN X-Forwarded-For YOK SAYILIR; acikken yalniz acik atlama sayisi/CIDR listesiyle (bkz. config.ts).
 */
export async function authenticateGuarded(
  pool: pg.Pool, req: { ip: string; headers: { authorization?: string } }, now: Date, failed: RateLimiter,
): Promise<AuthedDevice> {
  try {
    return await authenticate(pool, req.headers.authorization, now);
  } catch (e) {
    // GECERLI token'lar sinirdan etkilenmez (inceleme I-2: aksi halde baskasinin/paylasilan IP'sinden basarisiz denemeler
    // gondererek filo kilitlenebilirdi). Yalniz GECERSIZ istekler sayilir; sinir asilinca 401 yerine 429 alirlar.
    if (e instanceof HttpError && e.status === 401 && !failed.hit(ipKey(req.ip))) throw rateLimited(failed);
    throw e;
  }
}

/**
 * Bearer token'dan cihazi cozer. Gecerlilik: iptal edilmemis, suresi dolmamis, cihaz iptal edilmemis.
 * Rotation kurallari (B4):
 *  - Yerine yenisi uretilmis (superseded) eski token yalnizca ust uste binme suresince VE yeni token HENUZ
 *    kullanilmadiysa gecerlidir.
 *  - Yeni token kullanildiktan sonra eski token sunulursa: iki token da iptal edilir, cihaz isaretlenir, denetim olayi
 *    yazilir ve istek 401 olur (calinmis/kopyalanmis credential belirtisi).
 *  - Yeni token ilk kullanimda isaretlenir (first_used_at) ve sifreli kopyasi silinir.
 * Her basarisizlik ayni 401 govdesini dondurur.
 */
export async function authenticate(pool: pg.Pool, header: string | undefined, now: Date): Promise<AuthedDevice> {
  const token = parseBearer(header);
  if (!token) throw unauthorized();
  const hash = hashToken(token);
  const r = await pool.query<{
    org_id: string; device_id: string; first_used_at: Date | null;
    superseded_by: Buffer | null; overlap_expires_at: Date | null; succ_used_at: Date | null;
  }>(
    `SELECT t.org_id, t.device_id, t.first_used_at, t.superseded_by, t.overlap_expires_at, s.first_used_at AS succ_used_at
       FROM device_tokens t
       JOIN devices d ON d.id = t.device_id
       LEFT JOIN device_tokens s ON s.token_hash = t.superseded_by
      WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > $2)
        AND d.revoked_at IS NULL`,
    [hash, now],
  );
  const row = r.rows[0];
  if (!row) throw unauthorized();

  if (row.superseded_by) {
    if (row.succ_used_at) {
      await revokeAfterReuse(pool, row.org_id, row.device_id, hash, row.superseded_by, now);
      throw unauthorized();
    }
    if (!row.overlap_expires_at || row.overlap_expires_at <= now) throw unauthorized();
  } else if (!row.first_used_at) {
    await pool.query(
      "UPDATE device_tokens SET first_used_at=$2, credential_enc=NULL WHERE token_hash=$1 AND first_used_at IS NULL",
      [hash, now],
    );
  }
  return { orgId: row.org_id, deviceId: row.device_id, tokenHash: hash };
}

async function revokeAfterReuse(pool: pg.Pool, orgId: string, deviceId: string, oldHash: Buffer, newHash: Buffer, now: Date): Promise<void> {
  const c = await connectGuarded(pool);
  try {
    await c.query("BEGIN");
    await c.query("UPDATE device_tokens SET revoked_at=$3 WHERE token_hash = ANY($1::bytea[]) AND device_id=$2 AND revoked_at IS NULL", [[oldHash, newHash], deviceId, now]);
    await c.query("UPDATE devices SET compromised_at=COALESCE(compromised_at,$2) WHERE id=$1", [deviceId, now]);
    await c.query("INSERT INTO audit_events (ts, org_id, device_id, kind, detail) VALUES ($1,$2,$3,'credential_reuse',$4)",
      [now, orgId, deviceId, JSON.stringify({ reason: "superseded token presented after successor was used" })]);
    await c.query("COMMIT");
  } catch (e) {
    try { await c.query("ROLLBACK"); } catch { /* baglanti kopmus olabilir */ }
    throw e;
  } finally {
    releaseGuarded(c);
  }
}

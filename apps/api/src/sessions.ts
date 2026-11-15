import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";

export type Role = "owner" | "admin" | "viewer";

/** Boşta 30 dk, mutlak 12 sa (ChatGPT kararı 2026-11-15; owner/admin icin uzun sureli erisim sinirlanir). */
export interface SessionConfig { idleMs: number; absoluteMs: number }
export const DEFAULT_SESSION_CONFIG: SessionConfig = { idleMs: 30 * 60_000, absoluteMs: 12 * 3600_000 };

export interface SessionUser { userId: string; orgId: string; role: Role; email: string; sessionKey: string }

/** last_seen_at yazimi en cok bu sikliktadir: her istekte UPDATE yok. */
const TOUCH_INTERVAL_MS = 30_000;
const MAX_RAW_LENGTH = 128;

const digest = (raw: string) => createHash("sha256").update(raw, "utf8").digest();

export async function createSession(
  pool: pg.Pool, user: { id: string; orgId: string }, now: Date, cfg: SessionConfig, meta: { ip?: string; ua?: string },
): Promise<{ id: string; expiresAt: Date }> {
  const id = randomBytes(32).toString("base64url"); // 256 bit
  const expiresAt = new Date(now.getTime() + cfg.absoluteMs);
  await pool.query(
    "INSERT INTO sessions (id_hash, org_id, user_id, created_at, last_seen_at, expires_at, ip, ua) VALUES ($1,$2,$3,$4,$4,$5,$6,$7)",
    [digest(id), user.orgId, user.id, now, expiresAt, meta.ip ?? null, meta.ua?.slice(0, 256) ?? null],
  );
  return { id, expiresAt };
}

/** Gecerliyse kullaniciyi verir; yok / bosta asimi / mutlak asim / devre disi kullanici -> null (suresi dolan satir silinir). */
export async function resolveSession(pool: pg.Pool, rawId: string, now: Date, cfg: SessionConfig, opts: { touch?: boolean } = {}): Promise<SessionUser | null> {
  if (!rawId || rawId.length > MAX_RAW_LENGTH) return null;
  const key = digest(rawId);
  const r = await pool.query<{ org_id: string; user_id: string; last_seen_at: Date; expires_at: Date; role: Role; email: string; disabled_at: Date | null }>(
    `SELECT s.org_id, s.user_id, s.last_seen_at, s.expires_at, u.role, u.email, u.disabled_at
       FROM sessions s JOIN users u ON u.id = s.user_id AND u.org_id = s.org_id WHERE s.id_hash = $1`, [key]);
  const s = r.rows[0];
  if (!s) return null;
  const idleExpired = now.getTime() - s.last_seen_at.getTime() > cfg.idleMs;
  if (idleExpired || now.getTime() >= s.expires_at.getTime() || s.disabled_at) {
    await pool.query("DELETE FROM sessions WHERE id_hash = $1", [key]);
    return null;
  }
  // touch:false (SSE yeniden dogrulamasi): oturumu CANLI TUTMAZ; acik bir akis bosta asimini fiilen kapatmasin.
  if (opts.touch !== false && now.getTime() - s.last_seen_at.getTime() >= TOUCH_INTERVAL_MS) {
    await pool.query("UPDATE sessions SET last_seen_at = $2 WHERE id_hash = $1", [key, now]);
  }
  return { userId: s.user_id, orgId: s.org_id, role: s.role, email: s.email, sessionKey: key.toString("hex") };
}

export async function revokeSession(pool: pg.Pool, rawId: string): Promise<void> {
  if (!rawId || rawId.length > MAX_RAW_LENGTH) return;
  await pool.query("DELETE FROM sessions WHERE id_hash = $1", [digest(rawId)]);
}

/** Parola/rol/devre-disi degisiminde cagrilir: kullanicinin TUM oturumlari. Silinen sayiyi doner. */
export async function revokeAllForUser(pool: pg.Pool, userId: string): Promise<number> {
  const r = await pool.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
  return r.rowCount ?? 0;
}

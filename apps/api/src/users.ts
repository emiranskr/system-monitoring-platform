import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { connectGuarded, releaseGuarded } from "./db.js";
import { HttpError, badRequest } from "./errors.js";
import { jsonBody } from "./http-util.js";
import { MIN_PASSWORD_LENGTH, hashPassword, verifyDummy, verifyPassword } from "./password.js";
import { ipKey, rateLimited, type Limiters } from "./ratelimit.js";
import { COOKIE_NAME, clearSessionCookie, parseCookies, setSessionCookie } from "./session-guard.js";
import { createSession, resolveSession, revokeSession, type Role, type SessionConfig } from "./sessions.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest();

/**
 * Ilk kurulum: users bossa 256 bit tek kullanimlik token uretir ve YALNIZCA `write` ile BIR KEZ gosterir
 * (varsayilan: surec stderr'i; yapilandirilmis gunluge/dosyaya yazilmaz). DB'de yalniz SHA-256 ozeti. Onceki kullanilmamis
 * token'lar gecersiz kilinir. users doluysa hicbir sey yapmaz ve false doner.
 */
export async function ensureSetupToken(pool: pg.Pool, now: Date, write: (msg: string) => void): Promise<boolean> {
  const c = await connectGuarded(pool);
  try {
    await c.query("BEGIN");
    const n = Number((await c.query("SELECT count(*) FROM users")).rows[0].count);
    if (n > 0) { await c.query("ROLLBACK"); return false; }
    const token = randomBytes(32).toString("base64url");
    await c.query("DELETE FROM setup_tokens WHERE used_at IS NULL");
    await c.query("INSERT INTO setup_tokens (token_hash, created_at) VALUES ($1,$2)", [sha(token), now]);
    await c.query("COMMIT");
    write(`Ilk kurulum token'i (yalnizca bir kez gosterilir, saklanmaz): ${token}\n`);
    return true;
  } catch (e) {
    try { await c.query("ROLLBACK"); } catch { /* baglanti kopmus olabilir */ }
    throw e;
  } finally {
    releaseGuarded(c);
  }
}

const SetupBody = z.strictObject({
  token: z.string().min(20).max(200),
  email: z.email().max(254),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(256),
});
const LoginBody = z.strictObject({ email: z.string().min(3).max(254), password: z.string().min(1).max(256) });

const invalidCredentials = () => new HttpError(401, "invalid_credentials");

async function audit(pool: pg.Pool, now: Date, orgId: string | null, kind: string, detail: Record<string, unknown> = {}): Promise<void> {
  await pool.query("INSERT INTO audit_events (ts, org_id, kind, detail) VALUES ($1,$2,$3,$4)", [now, orgId, kind, JSON.stringify(detail)]);
}

export function registerAuthRoutes(app: FastifyInstance, pool: pg.Pool, now: () => Date, cfg: SessionConfig, limiters: Limiters): void {
  app.post("/api/v1/setup", async (req, reply) => {
    if (!limiters.setupPerIp.hit(ipKey(req.ip))) throw rateLimited(limiters.setupPerIp);
    const parsed = SetupBody.safeParse(jsonBody(req));
    if (!parsed.success) throw badRequest();
    const b = parsed.data;
    const t = now();
    if (Number((await pool.query("SELECT count(*) FROM users")).rows[0].count) > 0) throw new HttpError(404, "not_found"); // kurulum bitti: kalici kapali
    // Gecerli (kullanilmamis) token var mi? Pahali parola ozetinden ONCE ucuz kontrol; tuketim asagida ATOMIK.
    const exists = await pool.query("SELECT 1 FROM setup_tokens WHERE token_hash=$1 AND used_at IS NULL", [sha(b.token)]);
    if (exists.rowCount === 0) throw new HttpError(401, "unauthorized");
    const passwordHash = await hashPassword(b.password);

    const c = await connectGuarded(pool);
    try {
      await c.query("BEGIN");
      // ATOMIK tuketim: es zamanli istekler arasinda yalnizca biri satiri gunceller (RETURNING satiri dondurur).
      const used = await c.query("UPDATE setup_tokens SET used_at=$2 WHERE token_hash=$1 AND used_at IS NULL RETURNING 1", [sha(b.token), t]);
      if (used.rowCount === 0) { await c.query("ROLLBACK"); throw new HttpError(401, "unauthorized"); }
      const org = (await c.query<{ id: string }>("SELECT id FROM orgs ORDER BY created_at LIMIT 1")).rows[0]
        ?? (await c.query<{ id: string }>("INSERT INTO orgs (name) VALUES ('default') RETURNING id")).rows[0]!;
      await c.query("INSERT INTO users (org_id, email, password_hash, role) VALUES ($1,$2,$3,'owner')", [org.id, b.email.trim(), passwordHash]);
      await c.query("INSERT INTO audit_events (ts, org_id, kind) VALUES ($1,$2,'owner_created')", [t, org.id]);
      await c.query("COMMIT");
    } catch (e) {
      try { await c.query("ROLLBACK"); } catch { /* zaten geri alinmis */ }
      throw e;
    } finally {
      releaseGuarded(c);
    }
    return reply.status(201).send({ ok: true });
  });

  app.post("/api/v1/login", async (req, reply) => {
    const parsed = LoginBody.safeParse(jsonBody(req));
    if (!parsed.success) throw badRequest();
    const email = parsed.data.email.trim().toLowerCase();
    // Sinirdayken dogru parola da denenmez (kaba kuvvet). Iki anahtar: IP+e-posta ve IP.
    const ip = ipKey(req.ip);
    if (!limiters.loginPerIp.hit(ip)) throw rateLimited(limiters.loginPerIp);
    if (!limiters.loginPerKey.hit(`${ip}|${email}`)) throw rateLimited(limiters.loginPerKey);
    const t = now();

    const u = (await pool.query<{ id: string; org_id: string; password_hash: string; role: Role; email: string; disabled_at: Date | null }>(
      "SELECT id, org_id, password_hash, role, email, disabled_at FROM users WHERE lower(email) = $1", [email])).rows[0];
    let ok = false;
    if (!u || u.disabled_at) await verifyDummy(parsed.data.password); // ayni maliyet: zamanlamayla kullanici sayimi yok
    else ok = await verifyPassword(u.password_hash, parsed.data.password);
    if (!ok || !u) {
      await audit(pool, t, null, "login_failed"); // e-posta/parola yazilmaz
      throw invalidCredentials();
    }

    // Oturum sabitlemesine karsi: istekle gelen eski cerez varsa iptal edilir, HER ZAMAN yeni kimlik uretilir.
    const old = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (old) await revokeSession(pool, old);
    const s = await createSession(pool, { id: u.id, orgId: u.org_id }, t, cfg, { ip: req.ip, ua: req.headers["user-agent"] });
    setSessionCookie(reply, s.id, cfg.absoluteMs / 1000);
    await audit(pool, t, u.org_id, "login_ok", { user_id: u.id });
    return reply.send({ user: { email: u.email, role: u.role } });
  });

  app.post("/api/v1/logout", async (req, reply) => {
    const sid = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (sid) await revokeSession(pool, sid);
    await audit(pool, now(), req.session?.orgId ?? null, "logout", { user_id: req.session?.userId });
    reply.header("set-cookie", clearSessionCookie());
    return reply.status(204).send();
  });

  app.get("/api/v1/me", async (req) => ({ email: req.session!.email, role: req.session!.role }));
}

// Tip bagi: resolveSession disaridan kullanilabilir (SSE yeniden dogrulamasi icin ayni oturum cozucu).
export { resolveSession };

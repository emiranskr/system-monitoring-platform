import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { createEnrollmentToken, ENROLL_TOKEN_TTL_MS } from "./enrollment.js";
import { badRequest } from "./errors.js";
import { jsonBody } from "./http-util.js";
import { rateLimited, type Limiters } from "./ratelimit.js";
import { requireRole } from "./session-guard.js";

const Body = z.strictObject({ ttl_minutes: z.number().int().min(5).max(1440).optional() });

/** Yonetici (admin|owner): cihaz kaydi icin tek kullanimlik token. Token YALNIZCA bu yanitta doner; DB'de yalniz ozeti. */
export function registerEnrollmentAdmin(app: FastifyInstance, pool: pg.Pool, now: () => Date, limiters: Limiters): void {
  app.post("/api/v1/enrollment-tokens", { preHandler: requireRole("admin", "owner") }, async (req, reply) => {
    const s = req.session!;
    if (!limiters.enrollTokenPerUser.hit(s.userId)) throw rateLimited(limiters.enrollTokenPerUser);
    const parsed = Body.safeParse(jsonBody(req));
    if (!parsed.success) throw badRequest();
    const t = now();
    const ttlMs = (parsed.data.ttl_minutes ?? ENROLL_TOKEN_TTL_MS / 60_000) * 60_000;
    const token = await createEnrollmentToken(pool, s.orgId, { now: t, ttlMs });
    await pool.query("INSERT INTO audit_events (ts, org_id, kind, detail) VALUES ($1,$2,'enrollment_token_created',$3)",
      [t, s.orgId, JSON.stringify({ user_id: s.userId, ttl_minutes: ttlMs / 60_000 })]); // token yazilmaz
    return reply.status(201).send({ token, expires_at: new Date(t.getTime() + ttlMs).toISOString() });
  });
}

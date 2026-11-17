import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import type pg from "pg";
import { HttpError, unauthorized } from "./errors.js";
import { resolveSession, type Role, type SessionConfig, type SessionUser } from "./sessions.js";

declare module "fastify" {
  interface FastifyRequest { session?: SessionUser }
}

/** __Host- oneki: tarayici yalnizca Secure + Path=/ + Domain'siz cerezi kabul eder (alt alan adindan cerez enjeksiyonu yok). */
export const COOKIE_NAME = "__Host-sid";

/** Oturumsuz erisilebilen TEK /api/v1 yollari. Yeni bir genel yol eklemek bilincli bir karardir (IDOR paketi bu listeyi de denetler). */
export const PUBLIC_API_PATHS: ReadonlySet<string> = new Set(["/api/v1/login", "/api/v1/setup"]);

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue; // bozuk veya adsiz
    const name = part.slice(0, i).trim();
    if (!name) continue;
    out[name] = part.slice(i + 1).trim();
  }
  return out;
}

export function sessionCookie(raw: string, maxAgeSec: number): string {
  return `${COOKIE_NAME}=${raw}; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export const clearSessionCookie = (): string => `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;

export function setSessionCookie(reply: FastifyReply, raw: string, maxAgeSec: number): void {
  reply.header("set-cookie", sessionCookie(raw, maxAgeSec));
}

/**
 * /api/v1/* icin kapi: (1) durum degistiren istekte Origin izinli listede olmali (CSRF; SameSite=Lax ile birlikte), yoksa 403;
 * (2) genel yollar disinda gecerli oturum cerezi sart, yoksa 401. Agent yollari (/agent/v1/*) etkilenmez (bearer token).
 */
export function registerSessionGuard(app: FastifyInstance, pool: pg.Pool, now: () => Date, cfg: SessionConfig, allowedOrigins: readonly string[]): void {
  const origins = new Set(allowedOrigins);
  app.addHook("onRequest", async (req: FastifyRequest) => {
    // Karar YONLENDIRICININ ESLEDIGI rota desenine gore verilir (I-1): ham URL yuzde-kodlu (/api/v%31/..), mutlak biçimli
    // (GET http://host/api/v1/..) veya baska biçimde olabilir; yonlendirici bunlari cozup rotayi eslestirir, kapi ayni seyi gormelidir.
    // Ham yol da ek savunma olarak korunur (eslesmeyen /api/v1/ yollari 404'ten once de kapidan gecer).
    const matched = req.routeOptions?.url ?? "";
    const rawPath = req.url.split("?")[0]!;
    if (!matched.startsWith("/api/v1/") && !rawPath.startsWith("/api/v1/")) return;
    if (!SAFE_METHODS.has(req.method) && !origins.has(req.headers.origin ?? "")) throw new HttpError(403, "forbidden_origin");
    if (PUBLIC_API_PATHS.has(matched)) return; // genel mi: yalniz eslenen rota desenine gore
    const sid = parseCookies(req.headers.cookie)[COOKIE_NAME];
    const s = sid ? await resolveSession(pool, sid, now(), cfg) : null;
    if (!s) throw unauthorized();
    req.session = s;
  });
}

/** Rol kisiti (oturum kapisindan SONRA). Yetersiz rol -> 403. */
export const requireRole = (...roles: Role[]): preHandlerAsyncHookHandler => async (req) => {
  if (!req.session || !roles.includes(req.session.role)) throw new HttpError(403, "forbidden");
};

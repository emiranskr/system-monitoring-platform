import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import { registerIngest } from "./ingest.js";

export interface AppOptions {
  pool: pg.Pool;
  /** Enjekte edilebilir saat (testler icin). */
  now?: () => Date;
  /** Ters proxy arkasinda istemci IP'si icin; varsayilan KAPALI (X-Forwarded-For'a guvenilmez). */
  trustProxy?: boolean | string;
  logger?: boolean;
}

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: opts.logger
      ? { redact: ["req.headers.authorization", "req.headers.cookie"], level: "info" }
      : false,
    trustProxy: opts.trustProxy ?? false,
    bodyLimit: 1024 * 1024,
  });
  registerIngest(app, opts.pool, opts.now ?? (() => new Date()));
  return app;
}

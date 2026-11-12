import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import { HttpError } from "./errors.js";
import { registerEnroll } from "./enrollment.js";
import { registerIngest, MAX_COMPRESSED_BYTES } from "./ingest.js";
import { registerRotate } from "./rotation.js";

export interface AppOptions {
  pool: pg.Pool;
  /** 32 bayt AES-256-GCM anahtari: enrollment/rotation credential'lari yeniden deneme penceresi boyunca bununla sifreli tutulur. */
  credentialKey: Buffer;
  /** Enrollment yanitinda agent'a yankilanan SPKI parmak izleri (sha256/<base64>). */
  spkiPins?: string[];
  /** Enjekte edilebilir saat (testler icin). */
  now?: () => Date;
  /** Ters proxy arkasinda istemci IP'si icin; varsayilan KAPALI (X-Forwarded-For'a guvenilmez). */
  trustProxy?: boolean | string;
  logger?: boolean;
}

export function buildApp(opts: AppOptions): FastifyInstance {
  if (opts.credentialKey.length !== 32) throw new Error("credentialKey 32 bayt olmalidir (AES-256-GCM).");
  const now = opts.now ?? (() => new Date());
  const app = Fastify({
    logger: opts.logger
      ? { redact: ["req.headers.authorization", "req.headers.cookie"], level: "info" }
      : false,
    trustProxy: opts.trustProxy ?? false,
    bodyLimit: MAX_COMPRESSED_BYTES,
  });

  // Govde ham tampon: sikistirilmis <= 1 MB (asimda Fastify 413); gzip ve JSON her rota icinde sinirli islenir.
  app.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: MAX_COMPRESSED_BYTES }, (_req, body, done) => {
    done(null, body);
  });

  registerIngest(app, opts.pool, now);
  registerEnroll(app, opts.pool, now, opts.credentialKey, opts.spkiPins ?? []);
  registerRotate(app, opts.pool, now, opts.credentialKey);

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, ...err.extra });
    // Fastify'in kendi hatalari (govde cok buyuk 413, desteklenmeyen ortam 415, gecersiz govde 400)
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      const code = err.statusCode === 413 ? "payload_too_large" : err.statusCode === 415 ? "unsupported_media_type" : "bad_request";
      return reply.status(err.statusCode).send({ error: code });
    }
    app.log.error({ err: { message: err.message, code: err.code } }, "istek hatasi"); // govde/baslik loglanmaz
    return reply.status(500).send({ error: "internal" });
  });
  return app;
}

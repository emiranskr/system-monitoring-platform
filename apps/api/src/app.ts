import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import { HttpError } from "./errors.js";
import { registerEnroll } from "./enrollment.js";
import { registerIngest, MAX_COMPRESSED_BYTES } from "./ingest.js";
import { registerRotate } from "./rotation.js";
import { createLimiters, type Limits } from "./ratelimit.js";
import { DEFAULT_SESSION_CONFIG, type SessionConfig } from "./sessions.js";
import { registerSessionGuard } from "./session-guard.js";
import { registerAuthRoutes } from "./users.js";
import { registerDevices } from "./devices.js";
import { registerMetricsQuery } from "./metrics-query.js";
import { registerMetricNames } from "./metric-names.js";
import { registerEnrollmentAdmin } from "./enrollment-admin.js";
import { SampleBus } from "./events.js";
import { registerStream, type StreamOptions } from "./stream.js";
import { IngestHealth } from "./alerts/ingest-health.js";
import { startAlertJobs } from "./alerts/jobs.js";
import { OFFLINE_GRACE_MS } from "./alerts/model.js";
import type { LookupAll } from "./alerts/net-guard.js";
import { registerAlertRoutes } from "./alerts/routes.js";

export interface AppOptions {
  pool: pg.Pool;
  /** 32 bayt AES-256-GCM anahtari: enrollment/rotation credential'lari yeniden deneme penceresi boyunca bununla sifreli tutulur. */
  credentialKey: Buffer;
  /** Enrollment yanitinda agent'a yankilanan SPKI parmak izleri (sha256/<base64>). */
  spkiPins?: string[];
  /** Enjekte edilebilir saat (testler icin). */
  now?: () => Date;
  /** Ters proxy arkasinda istemci IP'si icin; varsayilan KAPALI (X-Forwarded-For'a guvenilmez). */
  trustProxy?: boolean | string | string[];
  logger?: boolean | { level: string };
  /** Agent'a ingest yanitinda bildirilen ornekleme araligi (sn, 1..300). Varsayilan 5: depolama butcesi (docs/ilerleme/M2.md). */
  sampleIntervalSeconds?: number;
  /** Hiz sinirlari (varsayilanlar ratelimit.ts'te). */
  limits?: Limits;
  /** Verilirse sunucu HTTPS dinler (TLS >= 1.2). Agent (Release) yalnizca HTTPS kabul eder. */
  https?: { key: string | Buffer; cert: string | Buffer };
  /** Panel (/api/v1) oturum ve CSRF ayarlari. allowedOrigins bos (varsayilan) ise durum degistiren /api/v1 istekleri REDDEDILIR. */
  auth?: { allowedOrigins: string[]; idleMinutes?: number; absoluteHours?: number };
  /** SSE zamanlayicilari (varsayilan: kalp atisi 25 sn, oturum yeniden dogrulama 60 sn); testler kisaltir. */
  stream?: StreamOptions;
  /**
   * Kanal sirlari (webhook URL'si, SMTP parolasi) icin AES-256-GCM anahtari (32 bayt; ortam: CHANNEL_KEY base64). Yoksa kanal olusturma
   * 503 doner ve bildirim gonderilmez (sirlar duz metin saklanmaz).
   */
  channelKey?: Buffer;
  /** Uyari sistemi (M5). `jobs: true` zamanlanmis degerlendirici + bildirim kuyrugunu baslatir (sunucu); testler elle cagirir. */
  alerts?: {
    jobs?: boolean;
    evaluateMs?: number;
    notifyMs?: number;
    /** YALNIZ gelistirme/test: ozel/loopback webhook/SMTP hedeflerine izin (SSRF korumasi KAPANIR). Uretimde ASLA. */
    allowPrivateTargets?: boolean;
    /** YALNIZ gelistirme/test: http:// webhook izni. Uretimde HTTPS zorunlu. */
    allowInsecureWebhooks?: boolean;
    /** Test: DNS cozumleyici. */
    lookup?: LookupAll;
  };
}

export function buildApp(opts: AppOptions): FastifyInstance {
  if (opts.credentialKey.length !== 32) throw new Error("credentialKey 32 bayt olmalidir (AES-256-GCM).");
  const sampleIntervalSeconds = opts.sampleIntervalSeconds ?? 5;
  if (!Number.isInteger(sampleIntervalSeconds) || sampleIntervalSeconds < 1 || sampleIntervalSeconds > 300) {
    throw new Error("sampleIntervalSeconds 1..300 arasi tam sayi olmalidir.");
  }
  const now = opts.now ?? (() => new Date());
  const REQUEST_TIMEOUT_MS = 30_000; // istek (basliktan govdenin sonuna) tamamlanma suresi; 1 MB govde icin cömertçe yeterli
  const CONNECTION_TIMEOUT_MS = 120_000; // bosta/yarim kalan baglanti (socket) zaman asimi
  const MAX_REQUESTS_PER_SOCKET = 1000;
  const app = Fastify({
    ...(opts.https ? { https: { key: opts.https.key, cert: opts.https.cert, minVersion: "TLSv1.2" as const } } : {}),
    logger: opts.logger
      ? { redact: ["req.headers.authorization", "req.headers.cookie"], level: typeof opts.logger === "object" ? opts.logger.level : "info" }
      : false,
    trustProxy: opts.trustProxy ?? false,
    bodyLimit: MAX_COMPRESSED_BYTES,
    // Yavas-yukleme (slowloris) korumasi; dogrudan TLS dagitiminda onde bir ters vekil olmayabilir.
    requestTimeout: REQUEST_TIMEOUT_MS,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    maxRequestsPerSocket: MAX_REQUESTS_PER_SOCKET,
  });

  // Govde ham tampon: sikistirilmis <= 1 MB (asimda Fastify 413); gzip ve JSON her rota icinde sinirli islenir.
  app.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: MAX_COMPRESSED_BYTES }, (_req, body, done) => {
    done(null, body);
  });

  // Kayitli rotalarin listesi (yalniz IDOR/rota-kapsam testi icin okunur): yeni bir rota eklenir de siniflandirilmazsa test kirilir.
  const routes: string[] = [];
  app.addHook("onRoute", (r) => { for (const m of [r.method].flat()) if (m !== "HEAD") routes.push(`${m} ${r.url}`); });
  app.decorate("registeredRoutes", routes);

  const sessionCfg: SessionConfig = {
    idleMs: (opts.auth?.idleMinutes ?? DEFAULT_SESSION_CONFIG.idleMs / 60_000) * 60_000,
    absoluteMs: (opts.auth?.absoluteHours ?? DEFAULT_SESSION_CONFIG.absoluteMs / 3600_000) * 3600_000,
  };
  // Oturum kapisi, /api/v1 rotalarindan ONCE kaydedilir (Fastify kancalari yalniz sonradan tanimlanan rotalara uygulanir).
  registerSessionGuard(app, opts.pool, now, sessionCfg, opts.auth?.allowedOrigins ?? []);

  const limiters = createLimiters(opts.limits, now);
  registerAuthRoutes(app, opts.pool, now, sessionCfg, limiters);
  registerDevices(app, opts.pool, now, sampleIntervalSeconds);
  registerMetricsQuery(app, opts.pool, now);
  registerMetricNames(app, opts.pool, now);
  registerEnrollmentAdmin(app, opts.pool, now, limiters);
  const bus = new SampleBus();
  app.decorate("sampleBus", bus);
  registerIngest(app, opts.pool, now, sampleIntervalSeconds, limiters, bus);
  registerStream(app, opts.pool, now, sessionCfg, bus, opts.stream);
  registerEnroll(app, opts.pool, now, opts.credentialKey, opts.spkiPins ?? [], limiters);
  registerRotate(app, opts.pool, now, opts.credentialKey, limiters);

  // M5: uyarilar. "Ingest saglikli" devre kesicisi: ingest 5xx (veritabani/ingest sorunu) cevrimdisi alarmlarini bastirir.
  const allowPrivate = opts.alerts?.allowPrivateTargets ?? false;
  const allowInsecure = opts.alerts?.allowInsecureWebhooks ?? false;
  const health = new IngestHealth(OFFLINE_GRACE_MS);
  app.decorate("ingestHealth", health);
  app.addHook("onResponse", async (req, reply) => {
    if (req.url.startsWith("/agent/v1/ingest") && reply.statusCode >= 500) health.recordFailure(now());
  });
  registerAlertRoutes(app, opts.pool, now, limiters, { channelKey: opts.channelKey, allowPrivateTargets: allowPrivate, allowInsecureWebhooks: allowInsecure, lookup: opts.alerts?.lookup });
  if (opts.alerts?.jobs) {
    startAlertJobs(app, opts.pool, {
      now, health, evaluateMs: opts.alerts.evaluateMs, notifyMs: opts.alerts.notifyMs,
      notifier: {
        secretKey: opts.channelKey, now,
        webhook: { allowPrivate, allowInsecureHttp: allowInsecure, timeoutMs: 5000, lookup: opts.alerts.lookup },
        email: { allowPrivate, allowInsecure: false, timeoutMs: 10_000, lookup: opts.alerts.lookup },
      },
    });
  }

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).headers(err.headers).send({ error: err.code, ...err.extra });
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

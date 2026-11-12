import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { MAX_SAMPLES_PER_BATCH, METRIC_NAME_RE, MetricValueSchema } from "@sysmon/protocol";
import { hashToken, parseBearer } from "./tokens.js";

const gunzipAsync = promisify(gunzip);

export const MAX_COMPRESSED_BYTES = 1024 * 1024; // 1 MB
export const MAX_DECOMPRESSED_BYTES = 10 * 1024 * 1024; // 10 MB (gzip bomb siniri)
export const MAX_METRICS_PER_SAMPLE = 256;
export const MAX_SENT_AT_SKEW_MS = 5 * 60_000; // sent_at: sunucu saatinden en cok +-5 dk
export const MAX_SAMPLE_AGE_MS = 24 * 3600_000; // 24 saatten eski ornek kalici ret
export const MAX_SAMPLE_FUTURE_MS = 2 * 60_000; // 2 dk'dan ileri ornek kalici ret

/**
 * Zarf semasi: ust duzey ve ornek alanlari KATI (govdede device_id dahil bilinmeyen alan -> 400).
 * Metrik ADLARI burada dogrulanmaz: kotu ad tum batch'i degil yalnizca o girdiyi reddeder (rejected++),
 * boylece agent'in 4xx ile "zehirli batch" sayaci kotu bir ad yuzunden tetiklenmez.
 */
const Envelope = z.strictObject({
  v: z.literal(1),
  spool_epoch: z.uuid(),
  seq: z.number().int().nonnegative().safe(),
  sent_at: z.iso.datetime(),
  samples: z
    .array(
      z.strictObject({
        ts: z.iso.datetime(),
        m: z.record(z.string(), MetricValueSchema).refine((m) => Object.keys(m).length <= MAX_METRICS_PER_SAMPLE),
      }),
    )
    .max(MAX_SAMPLES_PER_BATCH),
});

export interface Device { orgId: string; deviceId: string }
declare module "fastify" {
  interface FastifyRequest { device?: Device }
}

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** Tek tip hata govdesi: ayrinti (neden reddedildigi) disariya sizdirilmaz. */
class HttpError extends Error {
  constructor(public status: number, public code: string, public extra: Record<string, unknown> = {}) {
    super(code);
  }
}

export function registerIngest(app: FastifyInstance, pool: pg.Pool, now: () => Date): void {
  // Govde ham tampon olarak alinir (sikistirilmis <= 1 MB, asimda Fastify 413 verir); gzip burada, sinirli acilir.
  app.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: MAX_COMPRESSED_BYTES }, (_req, body, done) => {
    done(null, body);
  });

  app.route({
    method: "POST",
    url: "/agent/v1/ingest",
    // Kimlik dogrulama govde okunmadan ONCE: yetkisiz istek icin govde islenmez.
    onRequest: async (req: FastifyRequest) => {
      const token = parseBearer(req.headers.authorization);
      if (!token) throw new HttpError(401, "unauthorized");
      const r = await pool.query<{ org_id: string; device_id: string }>(
        `SELECT t.org_id, t.device_id
           FROM device_tokens t JOIN devices d ON d.id = t.device_id
          WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())
            AND d.revoked_at IS NULL`,
        [hashToken(token)],
      );
      const row = r.rows[0];
      if (!row) throw new HttpError(401, "unauthorized");
      req.device = { orgId: row.org_id, deviceId: row.device_id };
    },
    handler: async (req, reply) => {
      const device = req.device!;
      const raw = await decodeBody(req);
      let json: unknown;
      try {
        json = JSON.parse(raw.toString("utf8"));
      } catch {
        throw new HttpError(400, "bad_request");
      }
      const parsed = Envelope.safeParse(json);
      if (!parsed.success) throw new HttpError(400, "bad_request");
      const b = parsed.data;

      const t = now();
      if (Math.abs(new Date(b.sent_at).getTime() - t.getTime()) > MAX_SENT_AT_SKEW_MS) {
        // Saat sapmasi: gecici ret; agent server_time'dan ofset ogrenir ve ayni batch'i yeniden dener.
        throw new HttpError(409, "clock_skew", { server_time: iso(t) });
      }

      // Ornek ve metrik ayiklama: yalnizca gecerli girdiler yazilir; digerleri kalici ret (rejected).
      let rejected = 0;
      const ts: string[] = [], metric: string[] = [], value: (number | null)[] = [];
      for (const s of b.samples) {
        const at = new Date(s.ts).getTime();
        if (at < t.getTime() - MAX_SAMPLE_AGE_MS || at > t.getTime() + MAX_SAMPLE_FUTURE_MS) {
          rejected++;
          continue;
        }
        for (const [name, v] of Object.entries(s.m)) {
          if (name.length > 64 || !METRIC_NAME_RE.test(name)) {
            rejected++;
            continue;
          }
          ts.push(s.ts);
          metric.push(name);
          value.push(v);
        }
      }

      const ack = await commit(pool, device, b.spool_epoch, b.seq, { ts, metric, value }, t);
      return reply.send({ ack_seq: ack, rejected, server_time: iso(t) });
    },
  });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, ...err.extra });
    // Fastify'in kendi hatalari (govde cok buyuk 413, desteklenmeyen ortam 415, gecersiz govde 400)
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: err.statusCode === 413 ? "payload_too_large" : err.statusCode === 415 ? "unsupported_media_type" : "bad_request" });
    }
    app.log.error({ err: { message: err.message, code: err.code } }, "ingest hatasi"); // govde/baslik loglanmaz
    return reply.status(500).send({ error: "internal" });
  });
}

/** gzip'i sinirli acar: > 10 MB -> 413, bozuk gzip -> 400, bilinmeyen kodlama -> 415. */
async function decodeBody(req: FastifyRequest): Promise<Buffer> {
  const body = req.body;
  if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(400, "bad_request");
  const enc = (req.headers["content-encoding"] ?? "identity").toString().toLowerCase();
  if (enc === "identity") {
    if (body.length > MAX_DECOMPRESSED_BYTES) throw new HttpError(413, "payload_too_large");
    return body;
  }
  if (enc !== "gzip") throw new HttpError(415, "unsupported_media_type");
  try {
    return await gunzipAsync(body, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
  } catch (e) {
    if ((e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw new HttpError(413, "payload_too_large");
    throw new HttpError(400, "bad_request");
  }
}

/**
 * Tek islemde: (cihaz, epoch) satirini kilitle; seq daha once islendiyse hicbir sey yazma (idempotent, ack = son seq);
 * degilse ornekleri yaz (ON CONFLICT DO NOTHING), seq'i ilerlet. ack_seq = o istekte commit edilen son seq.
 */
async function commit(
  pool: pg.Pool, d: Device, epoch: string, seq: number,
  rows: { ts: string[]; metric: string[]; value: (number | null)[] }, t: Date,
): Promise<number> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      "INSERT INTO device_ingest_state (org_id, device_id, spool_epoch, last_seq) VALUES ($1,$2,$3,-1) ON CONFLICT DO NOTHING",
      [d.orgId, d.deviceId, epoch],
    );
    const st = await c.query<{ last_seq: string }>(
      "SELECT last_seq FROM device_ingest_state WHERE device_id=$1 AND spool_epoch=$2 FOR UPDATE",
      [d.deviceId, epoch],
    );
    const last = Number(st.rows[0]!.last_seq);
    if (seq <= last) {
      await c.query("COMMIT");
      return last; // yinelenen batch: veri zaten islendi
    }
    if (rows.ts.length > 0) {
      await c.query(
        `INSERT INTO metric_samples (ts, org_id, device_id, metric, value)
         SELECT u.t, $1::uuid, $2::uuid, u.m, u.v FROM unnest($3::timestamptz[], $4::text[], $5::float8[]) AS u(t, m, v)
         ON CONFLICT (device_id, metric, ts) DO NOTHING`,
        [d.orgId, d.deviceId, rows.ts, rows.metric, rows.value],
      );
    }
    await c.query("UPDATE device_ingest_state SET last_seq=$3, updated_at=$4 WHERE device_id=$1 AND spool_epoch=$2", [d.deviceId, epoch, seq, t]);
    await c.query("UPDATE devices SET last_seen_at=$2 WHERE id=$1", [d.deviceId, t]);
    await c.query("COMMIT");
    return seq;
  } catch (e) {
    try { await c.query("ROLLBACK"); } catch { /* baglanti kopmus olabilir */ }
    throw e;
  } finally {
    c.release();
  }
}

import { gunzip } from "node:zlib";
import { connectGuarded, releaseGuarded } from "./db.js";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { MAX_SAMPLES_PER_BATCH, METRIC_NAME_RE, MetricValueSchema } from "@sysmon/protocol";
import { authenticateGuarded, type AuthedDevice } from "./auth.js";
import { rateLimited, type Limiters } from "./ratelimit.js";
import { HttpError } from "./errors.js";
import type { SampleBus, SampleEvent } from "./events.js";

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
  interface FastifyRequest { auth?: AuthedDevice }
}

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** Batch'teki EN YENI ornegin metriklerinden olay uretir (panel son degeri gosterir; tam gecmis sorguyla gelir). */
function latestEvent(d: Device, ts: string[], metric: string[], value: (number | null)[]): SampleEvent {
  let best = 0;
  for (let i = 1; i < ts.length; i++) if (new Date(ts[i]!).getTime() > new Date(ts[best]!).getTime()) best = i;
  const bestT = new Date(ts[best]!).getTime();
  const values: Record<string, number | null> = {};
  for (let i = 0; i < ts.length; i++) if (new Date(ts[i]!).getTime() === bestT) values[metric[i]!] = value[i]!;
  return { orgId: d.orgId, deviceId: d.deviceId, t: new Date(bestT).toISOString(), values };
}

export function registerIngest(app: FastifyInstance, pool: pg.Pool, now: () => Date, sampleIntervalSeconds: number, limiters: Limiters, bus: SampleBus): void {
  app.route({
    method: "POST",
    url: "/agent/v1/ingest",
    // Kimlik dogrulama govde okunmadan ONCE: yetkisiz istek icin govde islenmez.
    onRequest: async (req: FastifyRequest) => {
      req.auth = await authenticateGuarded(pool, req, now(), limiters.failedAuthPerIp);
      // Cihaz basina sinir (kimlik dogrulamadan SONRA): sinirlanan istek veri yazmaz, agent ayni batch'i sonra yeniden dener.
      if (!limiters.ingestPerDevice.hit(req.auth.deviceId)) throw rateLimited(limiters.ingestPerDevice);
    },
    handler: async (req, reply) => {
      const device: Device = { orgId: req.auth!.orgId, deviceId: req.auth!.deviceId };
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

      const { ack, fresh } = await commit(pool, device, b.spool_epoch, b.seq, { ts, metric, value }, t);
      // Canli akis: yalnizca YENI islenen batch, COMMIT SONRASI, abone varsa; hata ingest'i etkilemez (events.ts).
      if (fresh && ts.length > 0 && bus.hasSubscribers(device.orgId)) {
        try { bus.publish(latestEvent(device, ts, metric, value)); } catch { /* yayin hatasi ingest'i bozmaz */ }
      }
      return reply.send({ ack_seq: ack, rejected, server_time: iso(t), config: { interval_seconds: sampleIntervalSeconds } });
    },
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
): Promise<{ ack: number; fresh: boolean }> {
  const c = await connectGuarded(pool);
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
      return { ack: last, fresh: false }; // yinelenen batch: veri zaten islendi (yayinlanmaz)
    }
    if (rows.ts.length > 0) {
      await c.query(
        // NOT EXISTS ON eleme ZORUNLUDUR (olculdu, TimescaleDB 2.17.2): SIKISTIRILMIS bir chunk'ta bir gercek yinelenen iceren tek
        // "INSERT ... ON CONFLICT DO NOTHING" ifadesi, ayni ifadedeki YENI satirlari da SESSIZCE YAZMAZ (0 satir, hata yok, 200+ack).
        // Yinelenenler once elenince yeni satirlar yazilir; ON CONFLICT yalnizca yarislara karsi emniyet olarak kalir.
        `INSERT INTO metric_samples (ts, org_id, device_id, metric, value)
         SELECT u.t, $1::uuid, $2::uuid, u.m, u.v FROM unnest($3::timestamptz[], $4::text[], $5::float8[]) AS u(t, m, v)
          WHERE NOT EXISTS (SELECT 1 FROM metric_samples e WHERE e.device_id = $2::uuid AND e.metric = u.m AND e.ts = u.t)
         ON CONFLICT (device_id, metric, ts) DO NOTHING`,
        [d.orgId, d.deviceId, rows.ts, rows.metric, rows.value],
      );
    }
    await c.query("UPDATE device_ingest_state SET last_seq=$3, updated_at=$4 WHERE device_id=$1 AND spool_epoch=$2", [d.deviceId, epoch, seq, t]);
    await c.query("UPDATE devices SET last_seen_at=$2 WHERE id=$1", [d.deviceId, t]);
    await c.query("COMMIT");
    return { ack: seq, fresh: true };
  } catch (e) {
    try { await c.query("ROLLBACK"); } catch { /* baglanti kopmus olabilir */ }
    throw e;
  } finally {
    releaseGuarded(c);
  }
}

import { z } from "zod";

/** Metrik adi: sabit noktali ad alani, en fazla 64 karakter. */
export const METRIC_NAME_RE = /^[a-z0-9_]+(\.[A-Za-z0-9_\-:]+){1,3}$/;
export const MAX_SAMPLES_PER_BATCH = 1000;

export const MetricNameSchema = z.string().max(64).regex(METRIC_NAME_RE);

const IsoTime = z.iso.datetime();

/** null = desteklenmiyor / kullanilamiyor. NaN ve Infinity reddedilir. */
export const MetricValueSchema = z.number().finite().nullable();

export const SampleSchema = z.strictObject({
  ts: IsoTime,
  m: z.record(MetricNameSchema, MetricValueSchema),
});

/**
 * Cihaz kimligi govdede tasinmaz; sunucu yalnizca bearer token'dan cozumler.
 * strictObject oldugu icin govdede device_id (eslesse de) reddedilir.
 */
export const IngestRequestSchema = z.strictObject({
  v: z.literal(1),
  spool_epoch: z.uuid(),
  seq: z.number().int().nonnegative(),
  sent_at: IsoTime,
  samples: z.array(SampleSchema).max(MAX_SAMPLES_PER_BATCH),
});
export type IngestRequest = z.infer<typeof IngestRequestSchema>;

export const IngestResponseSchema = z.strictObject({
  ack_seq: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  server_time: IsoTime,
  config: z.strictObject({ interval_seconds: z.number().int().positive() }).optional(),
  rotate: z.boolean().optional(),
});
export type IngestResponse = z.infer<typeof IngestResponseSchema>;

/** Hata siniflari: gecici -> ayni batch yeniden denenir; kalici -> ack ilerler, batch atilir. */
export type ErrorClass = "transient" | "permanent";

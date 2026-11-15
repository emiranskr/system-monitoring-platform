import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { METRIC_NAME_RE } from "@sysmon/protocol";
import { HttpError, badRequest } from "./errors.js";
import { notFound, resolveDevice } from "./devices.js";

const MAX_RANGE_MS = 31 * 24 * 3600_000;
const RAW_MAX_RANGE_MS = 3 * 3600_000; // ham veri yalniz <= 3 saatlik aralikta okunur
const RAW_RETENTION_MS = 3 * 24 * 3600_000; // ham saklama (0001: drop_after 3 gun)
const DEFAULT_POINTS = 600;

export type Source = "raw" | "1m";

/** Kisa ve yakin aralik ham veriden (5 sn cozunurluk), digerleri 1 dk katmanindan okunur. */
export function chooseSource(from: Date, to: Date, now: Date): Source {
  return to.getTime() - from.getTime() <= RAW_MAX_RANGE_MS && from.getTime() >= now.getTime() - RAW_RETENTION_MS ? "raw" : "1m";
}

/** Kova uzunlugu (sn): araligi max_points'e boler (yukari), kaynagin cozunurlugunun altina inmez; 1m icin 60 sn'nin kati. */
export function bucketSeconds(rangeSec: number, maxPoints: number, source: Source): number {
  const want = Math.max(1, Math.ceil(rangeSec / maxPoints));
  return source === "1m" ? Math.max(60, Math.ceil(want / 60) * 60) : want;
}

const Query = z.strictObject({
  metric: z.string().max(64).regex(METRIC_NAME_RE),
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  max_points: z.coerce.number().int().min(10).max(1500).optional(),
});

interface Point { t: string; avg: number; min: number; max: number }

export function registerMetricsQuery(app: FastifyInstance, pool: pg.Pool, now: () => Date): void {
  app.get<{ Params: { id: string } }>("/api/v1/devices/:id/metrics", async (req) => {
    const parsed = Query.safeParse(req.query);
    if (!parsed.success) throw badRequest();
    const q = parsed.data;
    const from = new Date(q.from), to = new Date(q.to);
    const range = to.getTime() - from.getTime();
    if (!(range > 0) || range > MAX_RANGE_MS) throw badRequest();

    // Cihaz YALNIZCA cagiranin org'unda cozulur; sonraki sorgular yalniz cozumlenmis kimlikle (serbest filtre yok).
    const orgId = req.session!.orgId;
    const dev = await resolveDevice(pool, orgId, req.params.id);
    if (!dev) throw notFound();

    const source = chooseSource(from, to, now());
    const bucket = bucketSeconds(range / 1000, q.max_points ?? DEFAULT_POINTS, source);
    const sql = source === "raw"
      ? `SELECT time_bucket(make_interval(secs => $5::float8), ts) AS t,
                avg(value)::float8 AS avg, min(value)::float8 AS min, max(value)::float8 AS max
           FROM metric_samples
          WHERE device_id = $1 AND org_id = $6 AND metric = $2 AND ts >= $3 AND ts < $4
          GROUP BY 1 HAVING count(value) > 0 ORDER BY 1`
      // Katman katmana: ortalama n ile agirliklandirilir (kovalar esit sayida ornek icermeyebilir).
      : `SELECT time_bucket(make_interval(secs => $5::float8), bucket) AS t,
                (sum(avg_value * n) / sum(n))::float8 AS avg, min(min_value)::float8 AS min, max(max_value)::float8 AS max
           FROM metric_1m
          WHERE device_id = $1 AND org_id = $6 AND metric = $2 AND bucket >= $3 AND bucket < $4
          GROUP BY 1 HAVING sum(n) > 0 ORDER BY 1`;
    const r = await pool.query<{ t: Date; avg: number; min: number; max: number }>(sql, [dev.id, q.metric, from, to, bucket, orgId]);
    const points: Point[] = r.rows.map((x) => ({ t: x.t.toISOString(), avg: Number(x.avg), min: Number(x.min), max: Number(x.max) }));
    return { metric: q.metric, from: from.toISOString(), to: to.toISOString(), source, bucket_seconds: bucket, points };
  });
}

void HttpError; // (hata siniflari errors.ts'te; burada yalniz badRequest/notFound kullanilir)

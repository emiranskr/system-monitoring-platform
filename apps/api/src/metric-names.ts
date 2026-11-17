import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { MAX_METRIC_NAMES } from "@sysmon/protocol";
import { notFound, resolveDevice } from "./devices.js";

/** Metrik kesfi penceresi: yalniz son 10 dk'da ornegi gelen metrikler (panelin sekmeleri gercek veriden turetilir). */
const WINDOW_MS = 10 * 60_000;

/**
 * GET /api/v1/devices/:id/metric-names -> { metrics: [{ name, last_ts }] }. Cihaz YALNIZCA cagiranin org'unda cozulur
 * (baska org/olmayan/uuid olmayan -> ayni 404). Siralama BAYT duzeninde (COLLATE "C") ada gore: yerel ayardan bagimsiz,
 * deterministik. En cok MAX_METRIC_NAMES (200); bos liste gecerli yanittir.
 */
export function registerMetricNames(app: FastifyInstance, pool: pg.Pool, now: () => Date): void {
  app.get<{ Params: { id: string } }>("/api/v1/devices/:id/metric-names", async (req) => {
    const orgId = req.session!.orgId;
    const dev = await resolveDevice(pool, orgId, req.params.id);
    if (!dev) throw notFound();
    const r = await pool.query<{ name: string; last_ts: Date }>(
      `SELECT metric AS name, max(ts) AS last_ts
         FROM metric_samples
        WHERE device_id = $1 AND org_id = $2 AND ts > $3
        GROUP BY metric
        ORDER BY metric COLLATE "C"
        LIMIT $4`,
      [dev.id, orgId, new Date(now().getTime() - WINDOW_MS), MAX_METRIC_NAMES]);
    return { metrics: r.rows.map((x) => ({ name: x.name, last_ts: x.last_ts.toISOString() })) };
  });
}

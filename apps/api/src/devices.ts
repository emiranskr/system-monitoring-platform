import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { HttpError } from "./errors.js";

export type DeviceStatus = "online" | "stale" | "offline" | "unknown" | "revoked";

const STALE_MS = 120_000; // 2 dk'ya kadar "bayat", sonrasi cevrimdisi
const MIN_ONLINE_MS = 30_000; // cevrimici siniri en az 30 sn

/** Cevrimici siniri = max(30 sn, 6 x ornekleme araligi) (agent batch'leri araliga bagli gelir). */
export function deviceStatus(lastSeenAt: Date | null, revokedAt: Date | null, now: Date, intervalSec: number): DeviceStatus {
  if (revokedAt) return "revoked";
  if (!lastSeenAt) return "unknown";
  const age = now.getTime() - lastSeenAt.getTime(); // gelecek tarihli (saat sapmasi) negatif: cevrimici
  if (age <= Math.max(MIN_ONLINE_MS, 6 * intervalSec * 1000)) return "online";
  return age <= STALE_MS ? "stale" : "offline";
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const notFound = () => new HttpError(404, "not_found");

/**
 * Cihazi YALNIZCA cagiranin org'unda cozer (serbest cihaz filtresi yok). uuid degilse, yoksa veya baska org'a aitse AYNI 404:
 * varlik/bicim bilgisi sizmaz.
 */
export async function resolveDevice(pool: pg.Pool, orgId: string, id: string): Promise<{ id: string; name: string; last_seen_at: Date | null; revoked_at: Date | null; device_info: unknown } | null> {
  if (!UUID_RE.test(id)) return null;
  const r = await pool.query("SELECT id, name, last_seen_at, revoked_at, device_info FROM devices WHERE id = $1 AND org_id = $2", [id, orgId]);
  return r.rows[0] ?? null;
}

/** Son degerler icin bakilan pencere: eski/sikistirilmis chunk'lara inmemek icin sinirli. */
const LATEST_WINDOW_MS = 10 * 60_000;

export function registerDevices(app: FastifyInstance, pool: pg.Pool, now: () => Date, intervalSec: number): void {
  app.get("/api/v1/devices", async (req) => {
    const t = now();
    // TEK sorgu: cihaz basina son degerler PK indeksi (device_id, metric, ts) uzerinden; N+1 yok.
    const r = await pool.query(
      `SELECT d.id, d.name, d.last_seen_at, d.revoked_at,
         (SELECT value FROM metric_samples m WHERE m.device_id = d.id AND m.metric = 'cpu.total' AND m.ts > $2 ORDER BY m.ts DESC LIMIT 1) AS cpu_pct,
         (SELECT value FROM metric_samples m WHERE m.device_id = d.id AND m.metric = 'mem.used_pct' AND m.ts > $2 ORDER BY m.ts DESC LIMIT 1) AS mem_pct,
         (SELECT max(v) FROM (SELECT DISTINCT ON (m.metric) m.value AS v FROM metric_samples m
            WHERE m.device_id = d.id AND m.metric LIKE 'disk.%.used_pct' AND m.ts > $2 ORDER BY m.metric, m.ts DESC) x) AS disk_used_pct
       FROM devices d WHERE d.org_id = $1 ORDER BY d.name, d.id`,
      [req.session!.orgId, new Date(t.getTime() - LATEST_WINDOW_MS)]);
    return {
      devices: r.rows.map((d) => ({
        id: d.id, name: d.name, status: deviceStatus(d.last_seen_at, d.revoked_at, t, intervalSec),
        last_seen_at: d.last_seen_at ? (d.last_seen_at as Date).toISOString() : null,
        cpu_pct: d.cpu_pct, mem_pct: d.mem_pct, disk_used_pct: d.disk_used_pct,
      })),
    };
  });

  app.get<{ Params: { id: string } }>("/api/v1/devices/:id", async (req) => {
    const d = await resolveDevice(pool, req.session!.orgId, req.params.id);
    if (!d) throw notFound();
    return {
      id: d.id, name: d.name, status: deviceStatus(d.last_seen_at, d.revoked_at, now(), intervalSec),
      last_seen_at: d.last_seen_at ? d.last_seen_at.toISOString() : null, device_info: d.device_info,
    };
  });
}

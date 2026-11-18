import type pg from "pg";

/**
 * Saklama temizligi (veri butunlugu): yalniz ESKI ve BITMIS veri silinir.
 * - Bildirimler: `sent`/`failed` ve `notificationDays` (varsayilan 30 gun) eski olanlar. `pending`/`sending` ASLA silinmez.
 * - Olaylar: COZULMUS (resolved_at dolu) ve `incidentDays` (varsayilan 180 gun) eski olanlar; bekleyen/gonderilen bildirimi olan olay
 *   silinmez; olayin kendi bildirimleri (FK) once silinir. ACIK olaylar yasi ne olursa olsun KALIR.
 * - Kural/kanal yumusak silmesi bu temizlikten bagimsizdir (olay gecmisi silmeyle yok olmaz).
 * Tek transaction; gecersiz sure (<=0) reddedilir, boylece yanlislikla tum gecmis silinmez.
 */
export interface RetentionOptions { notificationDays?: number; incidentDays?: number }
export interface RetentionResult { notifications: number; incidents: number }

export async function purgeAlertData(pool: pg.Pool, now: Date, o: RetentionOptions = {}): Promise<RetentionResult> {
  const nd = o.notificationDays ?? 30, id = o.incidentDays ?? 180;
  if (!Number.isFinite(nd) || nd <= 0 || !Number.isFinite(id) || id <= 0) throw new RangeError("saklama suresi pozitif olmali");
  const nCut = new Date(now.getTime() - nd * 86_400_000);
  const iCut = new Date(now.getTime() - id * 86_400_000);
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const n = await c.query("DELETE FROM notifications WHERE status IN ('sent','failed') AND COALESCE(sent_at, created_at) < $1", [nCut]);
    // Silinecek olaylar: cozulmus, eski ve bekleyen/gonderilen bildirimi OLMAYAN.
    const doomed = `SELECT i.id FROM incidents i WHERE i.resolved_at IS NOT NULL AND i.resolved_at < $1
                      AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.incident_id = i.id AND n.status IN ('pending','sending'))`;
    await c.query(`DELETE FROM notifications WHERE incident_id IN (${doomed})`, [iCut]);
    const i = await c.query(`DELETE FROM incidents WHERE id IN (${doomed})`, [iCut]);
    await c.query("COMMIT");
    return { notifications: n.rowCount ?? 0, incidents: i.rowCount ?? 0 };
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally { c.release(); }
}

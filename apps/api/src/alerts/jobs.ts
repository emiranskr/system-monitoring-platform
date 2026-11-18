import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { evaluateAlerts } from "./evaluator.js";
import type { IngestHealth } from "./ingest-health.js";
import { processNotifications, type NotifierDeps } from "./notifier.js";

export interface AlertJobsOptions {
  now: () => Date;
  health: IngestHealth;
  notifier: NotifierDeps;
  /** Degerlendirme araligi (varsayilan 15 sn). */
  evaluateMs?: number;
  /** Bildirim kuyrugu araligi (varsayilan 5 sn). */
  notifyMs?: number;
}

/**
 * Zamanlanmis isler (surec ici): degerlendirme (15 sn) ve bildirim kuyrugu (5 sn). Tur ust uste binmez (calisan tur bitmeden yenisi
 * baslamaz); coklu API ornegi durumunda degerlendirici tekilligini PostgreSQL advisory kilidi saglar (evaluator.ts).
 * Her turdan once veritabani sagligi sinanir: basarisizsa "ingest sagliksiz" isaretlenir (cevrimdisi alarmlari bastirilir).
 */
export function startAlertJobs(app: FastifyInstance, pool: pg.Pool, o: AlertJobsOptions): void {
  const startedAt = o.now();
  let evalRunning = false;
  let notifyRunning = false;

  const evalTimer = setInterval(() => {
    if (evalRunning) return;
    evalRunning = true;
    void (async () => {
      try {
        try { await pool.query("SELECT 1"); }
        catch { o.health.recordFailure(o.now()); return; }
        await evaluateAlerts(pool, o.now(), { startedAt, ingestHealthy: o.health.isHealthy(o.now()) });
      } catch (e) {
        app.log.error({ err: { message: (e as Error).message } }, "uyari degerlendirme hatasi");
      } finally { evalRunning = false; }
    })();
  }, o.evaluateMs ?? 15_000);

  const notifyTimer = setInterval(() => {
    if (notifyRunning) return;
    notifyRunning = true;
    void processNotifications(pool, o.notifier)
      .catch((e: Error) => app.log.error({ err: { message: e.message } }, "bildirim kuyrugu hatasi"))
      .finally(() => { notifyRunning = false; });
  }, o.notifyMs ?? 5_000);

  evalTimer.unref();
  notifyTimer.unref();
  app.addHook("onClose", async () => { clearInterval(evalTimer); clearInterval(notifyTimer); });
}

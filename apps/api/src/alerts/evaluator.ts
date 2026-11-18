import type pg from "pg";
import { BUILTIN_RULES, isAllowedMetric, metricLikePattern, OFFLINE_GRACE_MS, OFFLINE_METRIC } from "./model.js";
import { step, type MachineState, type Operator, type RuleParams } from "./machine.js";

/** Degerlendirici tekilligi: ayni anda yalniz BIR degerlendirici (coklu API ornegi/yarisan tur) calisir; PostgreSQL advisory kilidi. */
export const ALERT_LOCK_KEY = 727_001;

export interface EvalContext {
  /** Sunucu (surec) baslangic zamani: acilistan sonra `graceMs` boyunca cevrimdisi alarmi yok. */
  startedAt: Date;
  /** "Ingest saglikli" devre kesicisi: false ise cevrimdisi alarmlari bastirilir. */
  ingestHealthy: boolean;
  graceMs?: number;
}
export interface EvalResult { ran: boolean; fired: number; resolved: number }

interface RuleRow {
  id: string; org_id: string; name: string; metric: string; agg: "avg" | "max"; window_seconds: number; operator: Operator;
  threshold: number; hysteresis: number; for_seconds: number; severity: string; scope_device_ids: string[] | null; channel_ids: string[];
}
interface DeviceRow { id: string; name: string; last_seen_at: Date | null }

/** Yerlesik kurallari (yoksa) olusturur: orgId verilirse yalniz o organizasyon, yoksa hepsi. Idempotent. */
export async function ensureBuiltinRules(c: { query: pg.Pool["query"] }, orgId?: string): Promise<void> {
  for (const b of BUILTIN_RULES) {
    await c.query(
      `INSERT INTO alert_rules (org_id, name, metric, agg, window_seconds, operator, threshold, hysteresis, for_seconds, severity, builtin)
       SELECT o.id, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10 FROM orgs o WHERE ($11::uuid IS NULL OR o.id = $11::uuid)
       ON CONFLICT (org_id, builtin) WHERE builtin IS NOT NULL AND deleted_at IS NULL DO NOTHING`,
      [b.name, b.metric, b.agg, b.window_seconds, b.operator, b.threshold, b.hysteresis, b.for_seconds, b.severity, b.builtin, orgId ?? null]);
  }
}

export async function evaluateAlerts(pool: pg.Pool, now: Date, ctx: EvalContext): Promise<EvalResult> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const lock = await c.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS ok", [ALERT_LOCK_KEY]);
    if (!lock.rows[0]!.ok) { await c.query("ROLLBACK"); return { ran: false, fired: 0, resolved: 0 }; }

    await ensureBuiltinRules(c);
    const res: EvalResult = { ran: true, fired: 0, resolved: 0 };

    // Devre disi / silinmis kurallar: acik olaylar SESSIZCE kapanir (bildirim yok), durum temizlenir.
    await c.query(
      `UPDATE incidents SET resolved_at = $1 WHERE resolved_at IS NULL
         AND rule_id IN (SELECT id FROM alert_rules WHERE deleted_at IS NOT NULL OR NOT enabled)`, [now]);
    await c.query("DELETE FROM alert_state WHERE rule_id IN (SELECT id FROM alert_rules WHERE deleted_at IS NOT NULL OR NOT enabled)");

    const rules = (await c.query<RuleRow>("SELECT * FROM alert_rules WHERE deleted_at IS NULL AND enabled ORDER BY created_at, id")).rows;
    for (const rule of rules) {
      if (!isAllowedMetric(rule.metric)) continue;      // izin listesi disi (DB'ye dogrudan yazilmis) kural: atla
      await evaluateRule(c, rule, now, ctx, res);
    }
    await c.query("COMMIT");
    return res;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

async function evaluateRule(c: pg.PoolClient, rule: RuleRow, now: Date, ctx: EvalContext, res: EvalResult): Promise<void> {
  const devices = (await c.query<DeviceRow>(
    `SELECT id, name, last_seen_at FROM devices
      WHERE org_id = $1 AND revoked_at IS NULL AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))`,
    [rule.org_id, rule.scope_device_ids])).rows;
  const ids = devices.map((d) => d.id);

  // Kapsam disina cikan / iptal edilen cihazlar: acik olay sessizce kapanir, durum silinir.
  await c.query("UPDATE incidents SET resolved_at = $3 WHERE rule_id = $1 AND resolved_at IS NULL AND device_id <> ALL($2::uuid[])", [rule.id, ids, now]);
  await c.query("DELETE FROM alert_state WHERE rule_id = $1 AND device_id <> ALL($2::uuid[])", [rule.id, ids]);
  if (devices.length === 0) return;

  const isOffline = rule.metric === OFFLINE_METRIC;
  if (isOffline && (!ctx.ingestHealthy || now.getTime() - ctx.startedAt.getTime() < (ctx.graceMs ?? OFFLINE_GRACE_MS))) {
    // Cevrimdisi alarmi bastirilir: bekleyen PENDING sifirlanir (kurtarma sonrasi eski sayac ile hemen alarm olmasin).
    await c.query("UPDATE alert_state SET state = 'ok', pending_since = NULL, updated_at = $2 WHERE rule_id = $1 AND state = 'pending'", [rule.id, now]);
    return;
  }

  const values = isOffline ? offlineValues(devices, now) : await metricValues(c, rule, ids, now);
  const states = new Map((await c.query<{ device_id: string; state: MachineState["state"]; pending_since: Date | null }>(
    "SELECT device_id, state, pending_since FROM alert_state WHERE rule_id = $1", [rule.id])).rows.map((r) => [r.device_id, r]));
  const params: RuleParams = { operator: rule.operator, threshold: rule.threshold, hysteresis: rule.hysteresis, forSeconds: rule.for_seconds };

  for (const d of devices) {
    const value = values.get(d.id) ?? null;
    const prevRow = states.get(d.id);
    const prev: MachineState = prevRow ? { state: prevRow.state, pendingSince: prevRow.pending_since } : { state: "ok", pendingSince: null };
    const { next, transition } = step(prev, value, now, params);

    if (prevRow || next.state !== "ok") {
      await c.query(
        `INSERT INTO alert_state (rule_id, device_id, org_id, state, pending_since, last_value, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (rule_id, device_id) DO UPDATE SET state = EXCLUDED.state, pending_since = EXCLUDED.pending_since,
           last_value = COALESCE(EXCLUDED.last_value, alert_state.last_value), updated_at = EXCLUDED.updated_at`,
        [rule.id, d.id, rule.org_id, next.state, next.pendingSince, value, now]);
    }

    if (transition === "fire") {
      const inc = await c.query<{ id: string }>(
        `INSERT INTO incidents (org_id, rule_id, device_id, rule_name, device_name, metric, severity, opened_at, last_value, peak_value)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
         ON CONFLICT (rule_id, device_id) WHERE resolved_at IS NULL DO NOTHING RETURNING id`,
        [rule.org_id, rule.id, d.id, rule.name, d.name, rule.metric, rule.severity, now, value]);
      if (inc.rows[0]) {
        res.fired++;
        await enqueue(c, rule, d, inc.rows[0].id, "firing", value, now, null, now);
      }
    } else if (transition === "resolve") {
      const inc = await c.query<{ id: string; opened_at: Date }>(
        "UPDATE incidents SET resolved_at = $3, last_value = $4 WHERE rule_id = $1 AND device_id = $2 AND resolved_at IS NULL RETURNING id, opened_at",
        [rule.id, d.id, now, value]);
      if (inc.rows[0]) {
        res.resolved++;
        await enqueue(c, rule, d, inc.rows[0].id, "resolved", value, inc.rows[0].opened_at, now, now);
      }
    } else if (next.state === "firing" && value !== null) {
      // Sureklilik: son/tepe deger guncellenir (bildirim yok).
      const peak = rule.operator === ">" || rule.operator === ">=" ? "GREATEST" : "LEAST";
      await c.query(`UPDATE incidents SET last_value = $3, peak_value = ${peak}(COALESCE(peak_value, $3), $3) WHERE rule_id = $1 AND device_id = $2 AND resolved_at IS NULL`, [rule.id, d.id, value]);
    }
  }
}

function offlineValues(devices: DeviceRow[], now: Date): Map<string, number> {
  const m = new Map<string, number>();
  for (const d of devices) if (d.last_seen_at) m.set(d.id, Math.max(0, (now.getTime() - d.last_seen_at.getTime()) / 1000));  // NULL (hic gorulmemis) -> veri yok
  return m;
}

/** Pencere ortalamasi/maksimumu. Metrik adi, joker kalibi ve agg YALNIZ parametre (izin listesinden dogrulanmis). */
async function metricValues(c: pg.PoolClient, rule: RuleRow, ids: string[], now: Date): Promise<Map<string, number>> {
  const like = metricLikePattern(rule.metric);
  const from = new Date(now.getTime() - rule.window_seconds * 1000);
  const r = await c.query<{ device_id: string; v: number }>(
    `SELECT device_id, CASE WHEN $5::text = 'max' THEN max(value) ELSE avg(value) END AS v
       FROM metric_samples
      WHERE org_id = $1 AND device_id = ANY($2::uuid[]) AND ts > $3 AND ts <= $4 AND value IS NOT NULL
        AND (metric = $6 OR ($7::text IS NOT NULL AND metric LIKE $7 ESCAPE '\\'))
      GROUP BY device_id`,
    [rule.org_id, ids, from, now, rule.agg, rule.metric, like]);
  return new Map(r.rows.map((x) => [x.device_id, Number(x.v)]));
}

async function enqueue(c: pg.PoolClient, rule: RuleRow, d: DeviceRow, incidentId: string, kind: "firing" | "resolved", value: number | null, openedAt: Date, resolvedAt: Date | null, at: Date): Promise<void> {
  const chans = (await c.query<{ id: string }>(
    "SELECT id FROM notification_channels WHERE org_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL", [rule.org_id, rule.channel_ids])).rows;
  const payload = {
    kind, incident_id: incidentId, dedupe_key: `${incidentId}:${kind}`, rule_name: rule.name, device_name: d.name, metric: rule.metric, severity: rule.severity,
    value, operator: rule.operator, threshold: rule.threshold, opened_at: openedAt.toISOString(), resolved_at: resolvedAt ? resolvedAt.toISOString() : null,
  };
  for (const ch of chans) {
    await c.query(
      `INSERT INTO notifications (org_id, incident_id, channel_id, kind, status, next_attempt_at, payload)
       VALUES ($1,$2,$3,$4,'pending', $6, $5) ON CONFLICT (incident_id, kind, channel_id) DO NOTHING`,
      [rule.org_id, incidentId, ch.id, kind, JSON.stringify(payload), at]);
  }
}

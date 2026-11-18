import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { AlertRuleInputSchema, AlertRulePatchSchema, ChannelInputSchema, IncidentsQuerySchema, type AlertRuleInput } from "@sysmon/protocol";
import { UUID_RE } from "../devices.js";
import { badRequest, HttpError } from "../errors.js";
import { jsonBody } from "../http-util.js";
import { rateLimited, type Limiters } from "../ratelimit.js";
import { requireRole } from "../session-guard.js";
import { ensureBuiltinRules } from "./evaluator.js";
import { DnsResolveError, resolveSafe, SsrfError, type LookupAll } from "./net-guard.js";
import { encryptSecret, SecretsUnavailableError } from "./secrets.js";

export interface AlertRoutesOptions {
  /** Kanal sir anahtari (32 bayt). Yoksa kanal OLUSTURMA 503 doner (sirlar duz metin saklanmaz). */
  channelKey?: Buffer;
  /** YALNIZ gelistirme/test: ozel/loopback hedeflere izin. Uretimde false. */
  allowPrivateTargets: boolean;
  /** YALNIZ gelistirme/test: http:// webhook. Uretimde false (HTTPS zorunlu). */
  allowInsecureWebhooks: boolean;
  lookup?: LookupAll;
}

const MAX_RULES = 200;
const MAX_CHANNELS = 50;
const ADDR = /^[^\s@<>"',;\\]+@[^\s@<>"',;\\]+\.[^\s@<>"',;\\]+$/;
const notFound = () => new HttpError(404, "not_found");
const invalidRef = () => new HttpError(400, "invalid_reference");

interface RuleRow {
  id: string; name: string; metric: string; agg: string; window_seconds: number; operator: string; threshold: number; hysteresis: number;
  for_seconds: number; severity: string; scope_device_ids: string[] | null; channel_ids: string[]; builtin: string | null; enabled: boolean;
  created_at: Date; updated_at: Date;
}
const ruleOut = (r: RuleRow) => ({
  id: r.id, name: r.name, metric: r.metric, agg: r.agg, window_seconds: r.window_seconds, operator: r.operator, threshold: r.threshold, hysteresis: r.hysteresis,
  for_seconds: r.for_seconds, severity: r.severity, scope_device_ids: r.scope_device_ids, channel_ids: r.channel_ids, builtin: r.builtin, enabled: r.enabled,
  created_at: r.created_at.toISOString(), updated_at: r.updated_at.toISOString(),
});
const RULE_COLS = "id, name, metric, agg, window_seconds, operator, threshold, hysteresis, for_seconds, severity, scope_device_ids, channel_ids, builtin, enabled, created_at, updated_at";

/** Kuralin basvurdugu cihaz ve kanallarin TUMU bu organizasyona ait (ve kanallar silinmemis) olmali; aksi halde tek tip 400. */
async function checkRefs(pool: pg.Pool, orgId: string, scope: string[] | null, channels: string[]): Promise<void> {
  if (scope && scope.length > 0) {
    const n = (await pool.query<{ c: number }>("SELECT count(*)::int AS c FROM devices WHERE org_id = $1 AND id = ANY($2::uuid[])", [orgId, scope])).rows[0]!.c;
    if (n !== new Set(scope).size) throw invalidRef();
  }
  if (channels.length > 0) {
    const n = (await pool.query<{ c: number }>("SELECT count(*)::int AS c FROM notification_channels WHERE org_id = $1 AND deleted_at IS NULL AND id = ANY($2::uuid[])", [orgId, channels])).rows[0]!.c;
    if (n !== new Set(channels).size) throw invalidRef();
  }
}

export function registerAlertRoutes(app: FastifyInstance, pool: pg.Pool, now: () => Date, limiters: Limiters, o: AlertRoutesOptions): void {
  const admin = { preHandler: requireRole("admin", "owner") };

  // ---------- kurallar ----------
  app.get("/api/v1/alert-rules", async (req) => {
    const org = req.session!.orgId;
    await ensureBuiltinRules(pool, org);
    const r = await pool.query<RuleRow>(`SELECT ${RULE_COLS} FROM alert_rules WHERE org_id = $1 AND deleted_at IS NULL ORDER BY (builtin IS NULL), created_at, id`, [org]);
    return { rules: r.rows.map(ruleOut) };
  });

  app.post("/api/v1/alert-rules", admin, async (req, reply) => {
    const org = req.session!.orgId;
    const p = AlertRuleInputSchema.safeParse(jsonBody(req));
    if (!p.success) throw badRequest();
    const b = p.data;
    const count = (await pool.query<{ c: number }>("SELECT count(*)::int AS c FROM alert_rules WHERE org_id = $1 AND deleted_at IS NULL", [org])).rows[0]!.c;
    if (count >= MAX_RULES) throw new HttpError(409, "too_many_rules");
    await checkRefs(pool, org, b.scope_device_ids, b.channel_ids);
    const t = now();
    const r = await pool.query<RuleRow>(
      `INSERT INTO alert_rules (org_id, name, metric, agg, window_seconds, operator, threshold, hysteresis, for_seconds, severity, scope_device_ids, channel_ids, enabled, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15) RETURNING ${RULE_COLS}`,
      [org, b.name, b.metric, b.agg, b.window_seconds, b.operator, b.threshold, b.hysteresis, b.for_seconds, b.severity, b.scope_device_ids, b.channel_ids, b.enabled, req.session!.userId, t]);
    return reply.status(201).send(ruleOut(r.rows[0]!));
  });

  app.patch<{ Params: { id: string } }>("/api/v1/alert-rules/:id", admin, async (req) => {
    const org = req.session!.orgId;
    if (!UUID_RE.test(req.params.id)) throw notFound();
    const cur = (await pool.query<RuleRow>(`SELECT ${RULE_COLS} FROM alert_rules WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [req.params.id, org])).rows[0];
    if (!cur) throw notFound();
    const p = AlertRulePatchSchema.safeParse(jsonBody(req));
    if (!p.success) throw badRequest();
    if (cur.builtin && (p.data.metric !== undefined || p.data.name !== undefined)) throw new HttpError(400, "builtin_immutable");
    // Birlesmis degerler TAM kural semasindan gecer (alanlar arasi tutarlilik); sorgu yalniz sabit sutun adlariyla kurulur.
    const merged = { ...ruleOut(cur), ...p.data };
    const full = AlertRuleInputSchema.safeParse({
      name: merged.name, metric: merged.metric, agg: merged.agg, window_seconds: merged.window_seconds, operator: merged.operator, threshold: merged.threshold,
      hysteresis: merged.hysteresis, for_seconds: merged.for_seconds, severity: merged.severity, scope_device_ids: merged.scope_device_ids,
      channel_ids: merged.channel_ids, enabled: merged.enabled,
    });
    if (!full.success) throw badRequest();
    const b: AlertRuleInput = full.data;
    // Yalniz BU istekte degisen/verilen basvurular dogrulanir (silinmis eski kanal, ilgisiz bir PATCH'i engellemez).
    await checkRefs(pool, org, p.data.scope_device_ids === undefined ? null : b.scope_device_ids, p.data.channel_ids === undefined ? [] : b.channel_ids);
    const r = await pool.query<RuleRow>(
      `UPDATE alert_rules SET name=$3, metric=$4, agg=$5, window_seconds=$6, operator=$7, threshold=$8, hysteresis=$9, for_seconds=$10, severity=$11,
         scope_device_ids=$12, channel_ids=$13, enabled=$14, updated_at=$15
       WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL RETURNING ${RULE_COLS}`,
      [cur.id, org, b.name, b.metric, b.agg, b.window_seconds, b.operator, b.threshold, b.hysteresis, b.for_seconds, b.severity, b.scope_device_ids, b.channel_ids, b.enabled, now()]);
    return ruleOut(r.rows[0]!);
  });

  app.delete<{ Params: { id: string } }>("/api/v1/alert-rules/:id", admin, async (req, reply) => {
    const org = req.session!.orgId;
    if (!UUID_RE.test(req.params.id)) throw notFound();
    const cur = (await pool.query<{ builtin: string | null }>("SELECT builtin FROM alert_rules WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL", [req.params.id, org])).rows[0];
    if (!cur) throw notFound();
    if (cur.builtin) throw new HttpError(409, "builtin_not_deletable");
    await pool.query("UPDATE alert_rules SET deleted_at = $3, enabled = false, updated_at = $3 WHERE id = $1 AND org_id = $2", [req.params.id, org, now()]);
    await audit(pool, now(), org, "alert_rule_deleted", { user_id: req.session!.userId, rule_id: req.params.id });
    return reply.status(204).send();
  });

  // ---------- kanallar ----------
  app.get("/api/v1/notification-channels", async (req) => {
    const r = await pool.query<{ id: string; name: string; type: string; summary: unknown; created_at: Date }>(
      "SELECT id, name, type, summary, created_at FROM notification_channels WHERE org_id = $1 AND deleted_at IS NULL ORDER BY created_at, id", [req.session!.orgId]);
    return { channels: r.rows.map((c) => ({ id: c.id, name: c.name, type: c.type, summary: c.summary, created_at: c.created_at.toISOString() })) };
  });

  app.post("/api/v1/notification-channels", admin, async (req, reply) => {
    const org = req.session!.orgId;
    const p = ChannelInputSchema.safeParse(jsonBody(req));
    if (!p.success) throw badRequest();
    if (!o.channelKey || o.channelKey.length !== 32) throw new HttpError(503, "secrets_unavailable");   // sir anahtari yoksa GUVENLI basarisizlik
    const count = (await pool.query<{ c: number }>("SELECT count(*)::int AS c FROM notification_channels WHERE org_id = $1 AND deleted_at IS NULL", [org])).rows[0]!.c;
    if (count >= MAX_CHANNELS) throw new HttpError(409, "too_many_channels");

    const b = p.data;
    let config: Record<string, unknown>;
    let summary: Record<string, unknown>;
    try {
      if (b.type === "webhook") {
        let u: URL;
        try { u = new URL(b.url); } catch { throw badRequest(); }
        if (u.protocol !== "https:" && !(u.protocol === "http:" && o.allowInsecureWebhooks)) throw badRequest();
        if (u.username || u.password) throw badRequest();
        await resolveSafe(u.hostname, { allowPrivate: o.allowPrivateTargets, lookup: o.lookup });   // olusturmada da SSRF denetimi (gonderimde tekrar)
        config = { url: b.url, ...(b.secret ? { secret: b.secret } : {}) };
        summary = { host: u.hostname };
      } else {
        if (!ADDR.test(b.from) || !b.to.every((a) => ADDR.test(a))) throw badRequest();
        await resolveSafe(b.host, { allowPrivate: o.allowPrivateTargets, lookup: o.lookup });
        config = { host: b.host, port: b.port, secure: b.secure, ...(b.user !== undefined ? { user: b.user, pass: b.pass ?? "" } : {}), from: b.from, to: b.to };
        summary = { host: b.host, port: b.port, recipients: b.to.length };
      }
    } catch (e) {
      if (e instanceof SsrfError || e instanceof DnsResolveError) throw new HttpError(400, "blocked_target");
      throw e;
    }
    let enc: Buffer;
    try { enc = encryptSecret(o.channelKey, JSON.stringify(config)); }
    catch (e) { if (e instanceof SecretsUnavailableError) throw new HttpError(503, "secrets_unavailable"); throw e; }
    const t = now();
    const r = await pool.query<{ id: string; created_at: Date }>(
      "INSERT INTO notification_channels (org_id, name, type, config_enc, summary, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at",
      [org, b.name, b.type, enc, JSON.stringify(summary), req.session!.userId, t]);
    await audit(pool, t, org, "notification_channel_created", { user_id: req.session!.userId, channel_id: r.rows[0]!.id, type: b.type });   // sir yazilmaz
    return reply.status(201).send({ id: r.rows[0]!.id, name: b.name, type: b.type, summary, created_at: r.rows[0]!.created_at.toISOString() });
  });

  app.delete<{ Params: { id: string } }>("/api/v1/notification-channels/:id", admin, async (req, reply) => {
    const org = req.session!.orgId;
    if (!UUID_RE.test(req.params.id)) throw notFound();
    const t = now();
    const r = await pool.query("UPDATE notification_channels SET deleted_at = $3 WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL", [req.params.id, org, t]);
    if (r.rowCount === 0) throw notFound();
    await pool.query("UPDATE notifications SET status = 'failed', last_error = 'kanal silindi', lease_until = NULL WHERE channel_id = $1 AND org_id = $2 AND status IN ('pending','sending')", [req.params.id, org]);
    await pool.query("UPDATE alert_rules SET channel_ids = array_remove(channel_ids, $1::uuid), updated_at = $3 WHERE org_id = $2 AND $1::uuid = ANY(channel_ids)", [req.params.id, org, t]);
    await audit(pool, t, org, "notification_channel_deleted", { user_id: req.session!.userId, channel_id: req.params.id });
    return reply.status(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/v1/notification-channels/:id/test", admin, async (req, reply) => {
    const s = req.session!;
    if (!UUID_RE.test(req.params.id)) throw notFound();
    const ch = (await pool.query("SELECT 1 FROM notification_channels WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL", [req.params.id, s.orgId])).rows[0];
    if (!ch) throw notFound();
    if (!limiters.channelTestPerUser.hit(s.userId)) throw rateLimited(limiters.channelTestPerUser);
    const t = now();
    await pool.query(
      `INSERT INTO notifications (org_id, incident_id, channel_id, kind, status, next_attempt_at, payload) VALUES ($1, NULL, $2, 'test', 'pending', $3, $4)`,
      [s.orgId, req.params.id, t, JSON.stringify({
        kind: "test", dedupe_key: `test:${randomUUID()}`, rule_name: "Test bildirimi", device_name: "-", metric: "-", severity: "info", value: null,
        operator: ">", threshold: 0, opened_at: t.toISOString(), resolved_at: null,
      })]);
    return reply.status(202).send({ queued: true });
  });

  // ---------- olaylar ----------
  app.get("/api/v1/incidents", async (req) => {
    const q = IncidentsQuerySchema.safeParse(req.query);
    if (!q.success) throw badRequest();
    const r = await pool.query<{
      id: string; rule_id: string; rule_name: string; device_id: string; device_name: string; metric: string; severity: string;
      opened_at: Date; resolved_at: Date | null; last_value: number | null; peak_value: number | null;
    }>(
      `SELECT id, rule_id, rule_name, device_id, device_name, metric, severity, opened_at, resolved_at, last_value, peak_value
         FROM incidents
        WHERE org_id = $1 AND ($2::text = 'all' OR ($2::text = 'open' AND resolved_at IS NULL) OR ($2::text = 'resolved' AND resolved_at IS NOT NULL))
        ORDER BY opened_at DESC, id LIMIT $3`,
      [req.session!.orgId, q.data.state, q.data.limit]);
    return {
      incidents: r.rows.map((i) => ({
        ...i, opened_at: i.opened_at.toISOString(), resolved_at: i.resolved_at ? i.resolved_at.toISOString() : null,
      })),
    };
  });
}

async function audit(pool: pg.Pool, ts: Date, org: string, kind: string, detail: Record<string, unknown>): Promise<void> {
  await pool.query("INSERT INTO audit_events (ts, org_id, kind, detail) VALUES ($1,$2,$3,$4)", [ts, org, kind, JSON.stringify(detail)]);
}

import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { HttpError } from "./errors.js";
import { notFound, resolveDevice, UUID_RE } from "./devices.js";
import type { SampleBus } from "./events.js";
import { COOKIE_NAME, parseCookies } from "./session-guard.js";
import { resolveSession, type SessionConfig } from "./sessions.js";

export interface StreamOptions { heartbeatMs?: number; revalidateMs?: number }
const MAX_STREAMS_PER_USER = 3;
const MAX_DEVICES_FILTER = 50;
const SLOW_CONSUMER_BYTES = 1_048_576;

/**
 * GET /api/v1/stream?devices=<id,id,...> (Server-Sent Events). Yalniz oturumdaki org'un olaylari (fan-out anahtari org +
 * cihaz); `devices` verilirse her biri o org'da cozulur (yoksa/baska org'sa 404, akis hic acilmaz). Kullanici basina
 * en cok 3 es zamanli akis. 25 sn'de bir kalp atisi; 60 sn'de bir oturum yeniden cozulur (iptal/sure asimi/devre disi ->
 * "closed" olayi ve kapanis). Yavas tuketici (>1 MB birikim) kapatilir. Tek API ornegi varsayimi icin bkz. events.ts.
 */
export function registerStream(
  app: FastifyInstance, pool: pg.Pool, now: () => Date, cfg: SessionConfig, bus: SampleBus, opts: StreamOptions = {},
): void {
  const heartbeatMs = opts.heartbeatMs ?? 25_000;
  const revalidateMs = opts.revalidateMs ?? 60_000;
  const open = new Map<string, number>(); // userId -> acik akis sayisi

  app.get<{ Querystring: { devices?: string } }>("/api/v1/stream", async (req, reply) => {
    const s = req.session!;
    const raw = typeof req.query.devices === "string" && req.query.devices.length > 0 ? req.query.devices.split(",") : [];
    if (raw.length > MAX_DEVICES_FILTER) throw new HttpError(400, "bad_request");
    const wanted = new Set<string>();
    for (const id of raw) {
      if (!UUID_RE.test(id) || !(await resolveDevice(pool, s.orgId, id))) throw notFound(); // org disi/yok: ayni 404
      wanted.add(id.toLowerCase());
    }
    if ((open.get(s.userId) ?? 0) >= MAX_STREAMS_PER_USER) throw new HttpError(429, "too_many_streams", {}, { "retry-after": "5" });
    open.set(s.userId, (open.get(s.userId) ?? 0) + 1);

    const sid = parseCookies(req.headers.cookie)[COOKIE_NAME] ?? "";
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write("retry: 5000\nevent: ready\ndata: {}\n\n");

    let closed = false;
    const timers: NodeJS.Timeout[] = [];
    const unsubscribe = bus.subscribe(s.orgId, (ev) => {
      if (closed) return;
      if (wanted.size > 0 && !wanted.has(ev.deviceId)) return;
      res.write(`event: sample\ndata: ${JSON.stringify({ device_id: ev.deviceId, t: ev.t, values: ev.values })}\n\n`);
      if (res.writableLength > SLOW_CONSUMER_BYTES) finish("slow_consumer");
    });
    function finish(reason?: string): void {
      if (closed) return;
      closed = true;
      timers.forEach(clearInterval);
      unsubscribe();
      const n = (open.get(s.userId) ?? 1) - 1;
      if (n <= 0) open.delete(s.userId); else open.set(s.userId, n);
      if (reason && !res.writableEnded && !res.destroyed) res.end(`event: closed\ndata: ${JSON.stringify({ reason })}\n\n`);
      else if (!res.writableEnded && !res.destroyed) res.end();
    }
    timers.push(setInterval(() => { if (!closed) res.write(": ping\n\n"); }, heartbeatMs));
    timers.push(setInterval(() => {
      resolveSession(pool, sid, now(), cfg, { touch: false }).then((u) => { if (!u || u.userId !== s.userId) finish("session"); }, () => finish("session"));
    }, revalidateMs));
    req.raw.on("close", () => finish());
    res.on("close", () => finish());
  });
}

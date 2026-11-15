import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { createTestDb, type TestDb } from "@sysmon/db/testing";
import { buildApp, type AppOptions } from "../src/app.js";

/** Testler icin ortak duzen: gercek TimescaleDB (gecici DB) + gercek Fastify + enjekte edilebilir saat. */
export interface Kit {
  db: TestDb;
  app: FastifyInstance;
  clock: { now: Date };
  org: string;
  close(): Promise<void>;
}

export const KEY = Buffer.alloc(32, 7); // test AES-256 anahtari

/** Panel testlerinde izinli Origin (CSRF denetimi). */
export const ORIGIN = "https://panel.example.test";

export async function setupKit(opts: { spkiPins?: string[]; sampleIntervalSeconds?: number; trustProxy?: boolean | string[]; limits?: AppOptions["limits"]; auth?: AppOptions["auth"] } = {}): Promise<Kit> {
  const db = await createTestDb();
  const clock = { now: new Date("2026-11-12T12:00:00Z") };
  const app = buildApp({ pool: db.pool, now: () => clock.now, credentialKey: KEY, spkiPins: opts.spkiPins, sampleIntervalSeconds: opts.sampleIntervalSeconds, trustProxy: opts.trustProxy,
    auth: opts.auth ?? { allowedOrigins: [ORIGIN] },
    // Sinir testleri disindaki testler cok sayida istegi ayni IP'den ve sabit saatle yapar: sinirlar yuksek tutulur.
    limits: opts.limits ?? { enrollPerIp: 100_000, ingestPerDevice: 100_000, failedAuthPerIp: 100_000, rotatePerDevice: 100_000, loginPerKey: 100_000, loginPerIp: 100_000, setupPerIp: 100_000 } });
  await app.ready();
  const org = (await db.pool.query("INSERT INTO orgs (name) VALUES ('org') RETURNING id")).rows[0].id as string;
  return { db, app, clock, org, async close() { await app.close(); await db.drop(); } };
}

export const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
export const sha256 = (s: string) => createHash("sha256").update(s).digest();

export const deviceInfo = {
  hostname: "PC-01", os: "Windows 11", agent_version: "0.1.0", gpus: [], adapters: [{ id: "eth0", name: "Ethernet" }], volumes: [{ id: "C", name: "C:" }],
};

export function enrollBody(token: string, over: Record<string, unknown> = {}) {
  return { token, enroll_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", machine_guid: "guid-1", device_info: deviceInfo, ...over };
}

export const post = (k: Kit, url: string, payload: unknown, token?: string) =>
  k.app.inject({ method: "POST", url, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, payload: JSON.stringify(payload) });

/** Gecerli, bos bir ingest istegi: yalnizca token'in kabul edilip edilmedigini sinar. */
export function ping(k: Kit, token: string, seq = 0, epoch = "11111111-1111-4111-8111-111111111111") {
  const payload = { v: 1, spool_epoch: epoch, seq, sent_at: iso(k.clock.now), samples: [] };
  return k.app.inject({
    method: "POST", url: "/agent/v1/ingest",
    headers: { "content-type": "application/json", "content-encoding": "gzip", authorization: `Bearer ${token}` },
    payload: gzipSync(Buffer.from(JSON.stringify(payload))),
  });
}

/** Panel (/api/v1) istegi: izinli Origin ile; cookie verilirse oturumlu. */
export const api = (k: Kit, method: "GET" | "POST", url: string, opts: { body?: unknown; cookie?: string; origin?: string | null } = {}) =>
  k.app.inject({
    method, url,
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.origin === null ? {} : { origin: opts.origin ?? ORIGIN }),
    },
    ...(opts.body !== undefined ? { payload: JSON.stringify(opts.body) } : {}),
  });

/** Yanittaki Set-Cookie'den "ad=deger" cerez cifti (istek Cookie basligi icin); yoksa null. */
export function cookieFrom(res: { headers: Record<string, unknown> }): string | null {
  const sc = res.headers["set-cookie"];
  const s = Array.isArray(sc) ? sc[0] : sc;
  return typeof s === "string" && !/Max-Age=0/i.test(s) ? s.split(";")[0]! : null;
}

/** Dogrudan DB'ye kullanici ekler (parola ozeti gercek argon2id). */
export async function addUser(k: Kit, email: string, password: string, role: "owner" | "admin" | "viewer" = "admin", orgId = k.org): Promise<string> {
  const { hashPassword } = await import("../src/password.js");
  return (await k.db.pool.query("INSERT INTO users (org_id, email, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id", [orgId, email, await hashPassword(password), role])).rows[0].id as string;
}

/** Giris yapar, oturum cerezini (ad=deger) doner. */
export async function loginAs(k: Kit, email: string, password: string): Promise<string> {
  const r = await api(k, "POST", "/api/v1/login", { body: { email, password } });
  const c = cookieFrom(r);
  if (r.statusCode !== 200 || !c) throw new Error(`giris basarisiz: ${r.statusCode} ${r.body}`);
  return c;
}

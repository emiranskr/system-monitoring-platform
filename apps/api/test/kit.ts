import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { createTestDb, type TestDb } from "@sysmon/db/testing";
import { buildApp } from "../src/app.js";

/** Testler icin ortak duzen: gercek TimescaleDB (gecici DB) + gercek Fastify + enjekte edilebilir saat. */
export interface Kit {
  db: TestDb;
  app: FastifyInstance;
  clock: { now: Date };
  org: string;
  close(): Promise<void>;
}

export const KEY = Buffer.alloc(32, 7); // test AES-256 anahtari

export async function setupKit(opts: { spkiPins?: string[]; sampleIntervalSeconds?: number } = {}): Promise<Kit> {
  const db = await createTestDb();
  const clock = { now: new Date("2026-11-12T12:00:00Z") };
  const app = buildApp({ pool: db.pool, now: () => clock.now, credentialKey: KEY, spkiPins: opts.spkiPins, sampleIntervalSeconds: opts.sampleIntervalSeconds });
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

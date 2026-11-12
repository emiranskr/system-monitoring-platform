import { afterAll, describe, expect, it } from "vitest";
import { IngestResponseSchema } from "@sysmon/protocol";
import { buildApp } from "../src/app.js";
import { createEnrollmentToken } from "../src/enrollment.js";
import { enrollBody, KEY, ping, post, setupKit, type Kit } from "./kit.js";

/** Sunucu, ingest yanitinda agent'a ornekleme araligini bildirir (depolama butcesi; M2 olcumu). */
const kits: Kit[] = [];
afterAll(async () => { for (const k of kits) await k.close(); });

async function credentialFor(k: Kit): Promise<string> {
  const t = await createEnrollmentToken(k.db.pool, k.org, { now: k.clock.now });
  return (await post(k, "/agent/v1/enroll", enrollBody(t))).json().credential as string;
}

describe("ornekleme araligi (config.interval_seconds)", () => {
  it("varsayilan 5 sn; yanit protokol semasina uyar", async () => {
    const k = await setupKit(); kits.push(k);
    const r = await ping(k, await credentialFor(k));
    expect(r.statusCode).toBe(200);
    const body = IngestResponseSchema.parse(r.json());
    expect(body.config).toEqual({ interval_seconds: 5 });
  });

  it("yapilandirilan aralik yanita yansir", async () => {
    const k = await setupKit({ sampleIntervalSeconds: 15 }); kits.push(k);
    const r = await ping(k, await credentialFor(k));
    expect(r.json().config).toEqual({ interval_seconds: 15 });
  });

  it("yinelenen (replay) istek yanitinda da config bulunur", async () => {
    const k = await setupKit({ sampleIntervalSeconds: 10 }); kits.push(k);
    const c = await credentialFor(k);
    await ping(k, c, 3);
    const again = await ping(k, c, 3);
    expect(again.json().config).toEqual({ interval_seconds: 10 });
  });

  it.each([0, -1, 301, 1.5, Number.NaN])("gecersiz aralik (%s) uygulama kurulurken reddedilir", (v) => {
    expect(() => buildApp({ pool: {} as never, credentialKey: KEY, sampleIntervalSeconds: v })).toThrow(/sampleIntervalSeconds/);
  });
});

import { afterAll, describe, expect, it } from "vitest";
import { parseTrustProxy } from "../src/config.js";
import { createEnrollmentToken } from "../src/enrollment.js";
import { enrollBody, post, setupKit, type Kit } from "./kit.js";

const kits: Kit[] = [];
afterAll(async () => { for (const k of kits) await k.close(); });
const mk = async (opts: Parameters<typeof setupKit>[0] = {}) => { const k = await setupKit(opts); kits.push(k); return k; };

describe("TRUST_PROXY ayrisimi (inceleme I-1)", () => {
  it.each([undefined, "", "false", "0"])("%s -> kapali", (v) => expect(parseTrustProxy(v)).toBe(false));
  it("IP/CIDR listesi", () => {
    expect(parseTrustProxy("10.0.0.0/8, 192.168.1.5")).toEqual(["10.0.0.0/8", "192.168.1.5"]);
    expect(parseTrustProxy("fd00::/8")).toEqual(["fd00::/8"]);
  });
  it.each(["true", "TRUE", "yes", "tumu", "1", "2", "10.0.0.0/99", "abc", "1.2.3", "-1", "1.5", "10.0.0.1/8/8"])("guvensiz/gecersiz %s reddedilir", (v) => {
    expect(() => parseTrustProxy(v)).toThrow(/TRUST_PROXY/);
  });
});

describe("sahte X-Forwarded-For, guvenilen proxy ARKASINDA (inceleme I-1)", () => {
  const bad = (k: Kit, xff: string, token = "kotu") => k.app.inject({ method: "POST", url: "/agent/v1/ingest", remoteAddress: "10.9.9.9",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-forwarded-for": xff }, payload: "{}" });

  it("guvenilen proxy IP'si: istemcinin uydurdugu SOLDAKI girdi anahtari degistiremez; proxy'nin ekledigi SAGDAKI girdi esastir", async () => {
    const k = await mk({ trustProxy: ["10.9.9.9"], limits: { failedAuthPerIp: 2, windowMs: 60_000 } });
    // Saldirgan (gercek IP 203.0.113.7) her istekte farkli sahte ilk girdi gonderir; proxy gercek IP'yi SONA ekler.
    expect((await bad(k, "1.1.1.1, 203.0.113.7")).statusCode).toBe(401);
    expect((await bad(k, "2.2.2.2, 203.0.113.7")).statusCode).toBe(401);
    expect((await bad(k, "3.3.3.3, 203.0.113.7")).statusCode).toBe(429);   // sahte ilk girdi kacirmaz
    // Baska gercek istemci (farkli SON girdi) ayri sayilir
    expect((await bad(k, "1.1.1.1, 198.51.100.9")).statusCode).toBe(401);
  });
});

describe("basarisiz kimlik dogrulama siniri GECERLI token'lari engellemez (inceleme I-2)", () => {
  it("sinira ulasan IP'den GECERLI token yine kabul edilir; yalniz gecersizler 429 alir", async () => {
    const k = await mk({ limits: { failedAuthPerIp: 2, windowMs: 60_000 } });
    const t = await createEnrollmentToken(k.db.pool, k.org, { now: k.clock.now });
    const credential = (await post(k, "/agent/v1/enroll", enrollBody(t))).json().credential as string;
    const send = (token: string) => k.app.inject({ method: "POST", url: "/agent/v1/ingest", remoteAddress: "10.0.0.5",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, payload: "{}" });

    expect((await send("kotu1")).statusCode).toBe(401);
    expect((await send("kotu2")).statusCode).toBe(401);
    expect((await send("kotu3")).statusCode).toBe(429);          // gecersiz + sinir asildi
    expect((await send("kotu4")).statusCode).toBe(429);
    expect((await send(credential)).statusCode).not.toBe(429);   // GECERLI token ayni IP'den etkilenmez (400: bos govde)
    expect((await send(credential)).statusCode).not.toBe(401);
  });
});

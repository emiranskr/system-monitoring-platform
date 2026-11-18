import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { alertDevFlags } from "../src/alerts/devflags.js";

describe("gelistirme bayraklari uretimde REDDEDILIR (inceleme M-4)", () => {
  it("varsayilan: ikisi de kapali (NODE_ENV tanimsiz olsa bile hicbir sey kendiliginden acilmaz)", () => {
    expect(alertDevFlags({})).toEqual({ allowPrivateTargets: false, allowInsecureWebhooks: false });
    expect(alertDevFlags({ NODE_ENV: "development" })).toEqual({ allowPrivateTargets: false, allowInsecureWebhooks: false });
  });
  it("yalniz acik '1' bayragi acar; baska degerler ('true', '0', bos) kapali", () => {
    expect(alertDevFlags({ ALERT_ALLOW_PRIVATE_TARGETS: "1" })).toEqual({ allowPrivateTargets: true, allowInsecureWebhooks: false });
    expect(alertDevFlags({ ALERT_ALLOW_INSECURE_WEBHOOK: "1" })).toEqual({ allowPrivateTargets: false, allowInsecureWebhooks: true });
    for (const v of ["true", "0", "", "yes"]) expect(alertDevFlags({ ALERT_ALLOW_PRIVATE_TARGETS: v, ALERT_ALLOW_INSECURE_WEBHOOK: v })).toEqual({ allowPrivateTargets: false, allowInsecureWebhooks: false });
  });
  it("NODE_ENV=production iken HERHANGI bir bayrak sureci baslatmaz (hata firlatir); buyuk/kucuk harf ve bosluk fark etmez", () => {
    for (const env of ["production", "Production", " PRODUCTION "]) {
      expect(() => alertDevFlags({ NODE_ENV: env, ALERT_ALLOW_PRIVATE_TARGETS: "1" })).toThrow(/uretim/i);
      expect(() => alertDevFlags({ NODE_ENV: env, ALERT_ALLOW_INSECURE_WEBHOOK: "1" })).toThrow(/uretim/i);
    }
    expect(alertDevFlags({ NODE_ENV: "production" })).toEqual({ allowPrivateTargets: false, allowInsecureWebhooks: false });   // bayraksiz uretim sorunsuz
  });
});

describe("sunucu sureci (derlenmis dist/server.js): uretimde dev bayragiyla BASLAMAZ", () => {
  const server = fileURLToPath(new URL("../dist/server.js", import.meta.url));
  const run = (env: Record<string, string>) => spawnSync(process.execPath, [server], {
    encoding: "utf8", timeout: 20_000,
    env: { PATH: process.env.PATH ?? "", DATABASE_URL: "postgres://x:y@127.0.0.1:1/z", CREDENTIAL_KEY: Buffer.alloc(32, 1).toString("base64"), PORT: "0", ...env },
  });
  it("derlenmis dist/server.js MEVCUT olmali (yoksa bu kontroller sessizce atlanmaz: build calistirin)", () => { expect(existsSync(server), "apps/api/dist/server.js yok: pnpm build").toBe(true); });
  it("NODE_ENV=production + ALERT_ALLOW_PRIVATE_TARGETS=1 -> cikis kodu 2 ve acik hata (veritabanina baglanmadan)", () => {
    const r = run({ NODE_ENV: "production", ALERT_ALLOW_PRIVATE_TARGETS: "1" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/uretimde/i);
  });
  it("NODE_ENV=production + ALERT_ALLOW_INSECURE_WEBHOOK=1 -> cikis kodu 2", () => {
    expect(run({ NODE_ENV: "production", ALERT_ALLOW_INSECURE_WEBHOOK: "1" }).status).toBe(2);
  });
});

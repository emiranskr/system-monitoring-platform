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

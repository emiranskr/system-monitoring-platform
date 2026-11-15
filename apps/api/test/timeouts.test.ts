import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupKit, type Kit } from "./kit.js";

let k: Kit;
beforeAll(async () => { k = await setupKit(); }, 120_000);
afterAll(async () => { await k?.close(); });

// M-7: dogrudan TLS dagitiminda yavas-yukleme (slowloris) baglantilari sonsuza dek tutamamali.
describe("sunucu zaman asimlari", () => {
  it("istek ve baglanti zaman asimlari sinirlidir (0 = sinirsiz DEGIL)", () => {
    const s = k.app.server;
    expect(s.requestTimeout).toBeGreaterThan(0);
    expect(s.requestTimeout).toBeLessThanOrEqual(60_000);
    expect(s.timeout).toBeGreaterThan(0);
    expect(s.timeout).toBeLessThanOrEqual(300_000);
    expect(s.maxRequestsPerSocket).toBeGreaterThan(0);
  });
});

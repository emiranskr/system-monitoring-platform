import { describe, expect, it } from "vitest";
import { MIN_PASSWORD_LENGTH, hashPassword, verifyDummy, verifyPassword } from "../src/password.js";

const PW = "dogru-at-pil-zimba-42";

describe("parola ozeti (argon2id)", () => {
  it("dogru parola true, yanlis false", async () => {
    const h = await hashPassword(PW);
    expect(await verifyPassword(h, PW)).toBe(true);
    expect(await verifyPassword(h, PW + "x")).toBe(false);
  });

  it("ozet argon2id formatindadir ve parolayi icermez; iki ozet farkli (tuz)", async () => {
    const a = await hashPassword(PW), b = await hashPassword(PW);
    expect(a.startsWith("$argon2id$")).toBe(true);
    expect(a).not.toContain(PW);
    expect(a).not.toBe(b);
  });

  it("bozuk, bos veya baska bicimli ozet istisna FIRLATMAZ, false doner", async () => {
    for (const bad of ["", "xyz", "$argon2id$bozuk", "$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012"]) {
      expect(await verifyPassword(bad, PW)).toBe(false);
    }
  });

  it("verifyDummy olmayan kullanici yolunda gercek dogrulamayla AYNI buyuklukte maliyet oder (zamanlama sizintisi yok)", async () => {
    const h = await hashPassword(PW);
    const time = async (fn: () => Promise<unknown>) => { const t = performance.now(); await fn(); return performance.now() - t; };
    await verifyDummy("isitma"); await verifyPassword(h, "isitma"); // JIT/ilk cagri etkisini ele
    const real: number[] = [], dummy: number[] = [];
    for (let i = 0; i < 5; i++) { real.push(await time(() => verifyPassword(h, "yanlis-parola-1"))); dummy.push(await time(() => verifyDummy("yanlis-parola-1"))); }
    const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
    const ratio = med(dummy) / med(real);
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);
  });

  it("tek ozet maliyeti makul (yuk altinda giris gecikmesi): < 1 sn", async () => {
    const t = performance.now();
    await hashPassword(PW);
    expect(performance.now() - t).toBeLessThan(1000);
  });

  it("asgari parola uzunlugu 12", () => { expect(MIN_PASSWORD_LENGTH).toBe(12); });
});

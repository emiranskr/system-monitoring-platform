import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, parseChannelKey, SecretsUnavailableError } from "../src/alerts/secrets.js";

const KEY = Buffer.alloc(32, 9);

describe("kanal sirlari: AES-256-GCM", () => {
  it("gidis-donus; sifreli metin duz metni ICERMEZ", () => {
    const secret = JSON.stringify({ url: "https://hooks.example.com/T0/B0/xyzSECRET", password: "p@ss-SECRET" });
    const enc = encryptSecret(KEY, secret);
    expect(decryptSecret(KEY, enc)).toBe(secret);
    expect(enc.toString("latin1")).not.toContain("SECRET");
    expect(enc.toString("utf8")).not.toContain("hooks.example.com");
  });

  it("her sifrelemede BENZERSIZ nonce (10 000 sifrelemede tekrar yok) ve ayni duz metin farkli cikti verir", () => {
    const nonces = new Set<string>();
    const outs = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const e = encryptSecret(KEY, "ayni");
      nonces.add(e.subarray(0, 12).toString("hex"));
      if (i < 50) outs.add(e.toString("hex"));
    }
    expect(nonces.size).toBe(10_000);
    expect(outs.size).toBe(50);
  });

  it("bozulmus sifreli metin, etiket veya nonce DOGRULAMADA reddedilir (GCM)", () => {
    const enc = encryptSecret(KEY, "gizli");
    for (const idx of [0, 12, 20, enc.length - 1]) {
      const t = Buffer.from(enc);
      t[idx] = t[idx]! ^ 1;
      expect(() => decryptSecret(KEY, t)).toThrow();
    }
    expect(() => decryptSecret(KEY, enc.subarray(0, 20))).toThrow();   // kesik
  });

  it("yanlis anahtarla cozulemez", () => {
    expect(() => decryptSecret(randomBytes(32), encryptSecret(KEY, "x"))).toThrow();
  });

  it("anahtar EKSIK veya gecersiz uzunlukta ise sifreleme/cozme guvenli basarisiz olur (SecretsUnavailableError)", () => {
    for (const bad of [undefined, Buffer.alloc(0), Buffer.alloc(16), Buffer.alloc(31), Buffer.alloc(33)]) {
      expect(() => encryptSecret(bad, "x")).toThrow(SecretsUnavailableError);
      expect(() => decryptSecret(bad, Buffer.alloc(60))).toThrow(SecretsUnavailableError);
    }
  });

  it("parseChannelKey: gecerli base64 32 bayt kabul; bos/kisa/uzun/bozuk reddedilir (undefined doner)", () => {
    expect(parseChannelKey(randomBytes(32).toString("base64"))?.length).toBe(32);
    for (const bad of [undefined, "", "   ", randomBytes(16).toString("base64"), randomBytes(33).toString("base64"), "***bozuk***"]) {
      expect(parseChannelKey(bad)).toBeUndefined();
    }
  });
});

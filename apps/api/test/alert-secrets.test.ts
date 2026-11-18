import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { channelAad, decryptSecret, encryptSecret, parseChannelKey, SecretsUnavailableError } from "../src/alerts/secrets.js";

const KEY = Buffer.alloc(32, 9);
const AAD = channelAad("org-1", "ch-1");

describe("kanal sirlari: AES-256-GCM", () => {
  it("gidis-donus; sifreli metin duz metni ICERMEZ", () => {
    const secret = JSON.stringify({ url: "https://hooks.example.com/T0/B0/xyzSECRET", password: "p@ss-SECRET" });
    const enc = encryptSecret(KEY, secret, AAD);
    expect(decryptSecret(KEY, enc, AAD)).toBe(secret);
    expect(enc.toString("latin1")).not.toContain("SECRET");
    expect(enc.toString("utf8")).not.toContain("hooks.example.com");
  });

  it("her sifrelemede BENZERSIZ nonce (10 000 sifrelemede tekrar yok) ve ayni duz metin farkli cikti verir", () => {
    const nonces = new Set<string>();
    const outs = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const e = encryptSecret(KEY, "ayni", AAD);
      nonces.add(e.subarray(0, 12).toString("hex"));
      if (i < 50) outs.add(e.toString("hex"));
    }
    expect(nonces.size).toBe(10_000);
    expect(outs.size).toBe(50);
  });

  it("bozulmus sifreli metin, etiket veya nonce DOGRULAMADA reddedilir (GCM)", () => {
    const enc = encryptSecret(KEY, "gizli", AAD);
    for (const idx of [0, 12, 20, enc.length - 1]) {
      const t = Buffer.from(enc);
      t[idx] = t[idx]! ^ 1;
      expect(() => decryptSecret(KEY, t, AAD)).toThrow();
    }
    expect(() => decryptSecret(KEY, enc.subarray(0, 20), AAD)).toThrow();   // kesik
  });

  it("yanlis anahtarla cozulemez", () => {
    expect(() => decryptSecret(randomBytes(32), encryptSecret(KEY, "x", AAD), AAD)).toThrow();
  });

  it("anahtar EKSIK veya gecersiz uzunlukta ise sifreleme/cozme guvenli basarisiz olur (SecretsUnavailableError)", () => {
    for (const bad of [undefined, Buffer.alloc(0), Buffer.alloc(16), Buffer.alloc(31), Buffer.alloc(33)]) {
      expect(() => encryptSecret(bad, "x", AAD)).toThrow(SecretsUnavailableError);
      expect(() => decryptSecret(bad, Buffer.alloc(60), AAD)).toThrow(SecretsUnavailableError);
    }
  });

  it("parseChannelKey: gecerli base64 32 bayt kabul; bos/kisa/uzun/bozuk reddedilir (undefined doner)", () => {
    expect(parseChannelKey(randomBytes(32).toString("base64"))?.length).toBe(32);
    for (const bad of [undefined, "", "   ", randomBytes(16).toString("base64"), randomBytes(33).toString("base64"), "***bozuk***"]) {
      expect(parseChannelKey(bad)).toBeUndefined();
    }
  });

  it("AAD (inceleme M-2): baska organizasyon/kanal baglaminda COZME REDDEDILIR; dogru baglamda cozulur", () => {
    const enc = encryptSecret(KEY, "gizli", channelAad("org-A", "ch-1"));
    expect(decryptSecret(KEY, enc, channelAad("org-A", "ch-1"))).toBe("gizli");
    expect(() => decryptSecret(KEY, enc, channelAad("org-B", "ch-1"))).toThrow();   // baska org
    expect(() => decryptSecret(KEY, enc, channelAad("org-A", "ch-2"))).toThrow();   // baska kanal (satir kopyalama)
    expect(() => decryptSecret(KEY, enc, "")).toThrow();
    expect(channelAad("a", "b")).not.toBe(channelAad("ab", ""));                     // belirsiz birlestirme yok
  });
});

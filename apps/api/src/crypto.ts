import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** AES-256-GCM: cikti = iv(12) | tag(16) | sifreli. Anahtar 32 bayt olmak zorundadir. */
export function encrypt(key: Buffer, plain: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

export function decrypt(key: Buffer, blob: Buffer): string {
  const d = createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString("utf8");
}

/** Yeni credential: 256 bit rastgele, URL-guvenli (43 karakter) + okunabilir on ek. */
export function newCredential(): string {
  return "sm_" + randomBytes(32).toString("base64url");
}

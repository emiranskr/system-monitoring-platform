import { createHash } from "node:crypto";

/** Token'in SHA-256 ozeti. Ham token asla saklanmaz/loglanmaz; arama bu ozet uzerinden yapilir. */
export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** "Authorization: Bearer <token>" basligindan token'i alir; baska sema veya bos/asiri uzun deger null. */
export function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer ([\x21-\x7e]{1,512})$/.exec(header);
  return m?.[1] ?? null;
}

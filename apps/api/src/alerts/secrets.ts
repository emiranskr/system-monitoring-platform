import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Kanal sirlari (webhook URL'si/imza sirri, SMTP sunucusu/parolasi, alicilar) AES-256-GCM ile sifreli saklanir.
 * Bicim: nonce(12) || etiket(16) || sifreli metin; AAD = org+kanal kimligi (channelAad). Surum notu: M5 henuz yayinlanmadi, AAD'siz eski kayit yoktur (uyumluluk dali gerekmedi). HER sifrelemede yeni rastgele nonce (CSPRNG).
 * Anahtar eksik/gecersizse sifreleme ve cozme GUVENLI BICIMDE basarisiz olur (duz metin yazilmaz/gonderilmez).
 * Sifreli sirlar API uzerinden ASLA geri dondurulmez.
 */
export class SecretsUnavailableError extends Error {
  constructor() { super("kanal sir anahtari (CHANNEL_KEY, 32 bayt) yok veya gecersiz"); }
}

const NONCE = 12;
const TAG = 16;

function checkKey(key: Buffer | undefined): Buffer {
  if (!key || key.length !== 32) throw new SecretsUnavailableError();
  return key;
}

/** CHANNEL_KEY ortam degiskeni (base64, tam 32 bayt). Gecersizse undefined (kanal sirlari kullanilamaz). */
export function parseChannelKey(v: string | undefined): Buffer | undefined {
  if (!v || !v.trim()) return undefined;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(v.trim())) return undefined;
  const b = Buffer.from(v.trim(), "base64");
  return b.length === 32 ? b : undefined;
}

/** Sifreleme baglami (AAD): sir YALNIZ kendi organizasyonu+kanali icin cozulur (satir kopyalama/baska org reddedilir). Uzunluk onekli: belirsiz birlestirme yok. */
export function channelAad(orgId: string, channelId: string): string {
  return `${orgId.length}:${orgId}:${channelId}`;
}

export function encryptSecret(key: Buffer | undefined, plaintext: string, aad: string): Buffer {
  const k = checkKey(key);
  const nonce = randomBytes(NONCE);
  const c = createCipheriv("aes-256-gcm", k, nonce);
  c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return Buffer.concat([nonce, c.getAuthTag(), ct]);
}

export function decryptSecret(key: Buffer | undefined, blob: Buffer, aad: string): string {
  const k = checkKey(key);
  if (blob.length < NONCE + TAG) throw new Error("sifreli sir bozuk");
  const d = createDecipheriv("aes-256-gcm", k, blob.subarray(0, NONCE));
  d.setAuthTag(blob.subarray(NONCE, NONCE + TAG));
  d.setAAD(Buffer.from(aad, "utf8"));
  return Buffer.concat([d.update(blob.subarray(NONCE + TAG)), d.final()]).toString("utf8");
}

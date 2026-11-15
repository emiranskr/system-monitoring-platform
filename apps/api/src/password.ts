import { randomBytes } from "node:crypto";
import { Algorithm, hash, verify } from "@node-rs/argon2";

export const MIN_PASSWORD_LENGTH = 12;

/**
 * argon2id parametreleri. OWASP asgarisi (m >= 19 MiB, t >= 2, p = 1) USTUNDE. Bu makinede OLCULDU (ozet basina):
 * 19 MiB/t2 ~7 ms, 32 MiB/t3 ~17 ms, 64 MiB/t3 ~45 ms, 128 MiB/t3 ~79 ms. 64 MiB/t3 secildi: asgarinin ~3.4 kati bellek,
 * giris gecikmesi ~45 ms; 128 MiB daha yavas ama es zamanli girislerde bellek tabanli hizmet reddi riskini buyutur
 * (giris hiz sinirli, yine de 2 vCPU/4 GB referans makinede bellek payi korunur).
 * Parametreler ozetin icine kodlanir; ileride artirilirsa eski ozetler dogrulanmaya devam eder.
 */
export const ARGON2_PARAMS = { algorithm: Algorithm.Argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;

export function hashPassword(pw: string): Promise<string> {
  return hash(pw, ARGON2_PARAMS);
}

/** Bozuk/yabanci bicimli ozet istisna FIRLATMAZ: false doner. */
export async function verifyPassword(encoded: string, pw: string): Promise<boolean> {
  if (!encoded.startsWith("$argon2")) return false;
  try {
    return await verify(encoded, pw);
  } catch {
    return false;
  }
}

// Kullanici yokken ayni maliyeti odemek icin sabit sahte ozet (sureç basina bir kez, tembel uretilir).
let dummy: Promise<string> | undefined;

/** Olmayan/devre disi kullanici yolunda gercek dogrulamayla ayni maliyeti oder: zamanlamayla kullanici sayimi yapilamaz. */
export async function verifyDummy(pw: string): Promise<void> {
  dummy ??= hashPassword(randomBytes(16).toString("hex"));
  await verifyPassword(await dummy, pw);
}

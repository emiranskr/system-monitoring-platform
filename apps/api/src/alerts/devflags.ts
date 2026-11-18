/**
 * Gelistirme/test bayraklari (ozel hedeflere ve http:// webhook'a izin) YALNIZ acik "1" degeriyle acilir; varsayilan KAPALI
 * (NODE_ENV tanimsiz/yanlis olsa bile hicbir sey kendiliginden acilmaz). NODE_ENV=production iken HERHANGI bir bayrak verilmisse
 * surec baslatilmaz (hata): SSRF korumasi uretimde bir ortam degiskeniyle kapatilamaz.
 */
export interface AlertDevFlags { allowPrivateTargets: boolean; allowInsecureWebhooks: boolean }

export function alertDevFlags(env: Record<string, string | undefined>): AlertDevFlags {
  const flags = { allowPrivateTargets: env.ALERT_ALLOW_PRIVATE_TARGETS === "1", allowInsecureWebhooks: env.ALERT_ALLOW_INSECURE_WEBHOOK === "1" };
  if ((flags.allowPrivateTargets || flags.allowInsecureWebhooks) && (env.NODE_ENV ?? "").trim().toLowerCase() === "production") {
    throw new Error("ALERT_ALLOW_PRIVATE_TARGETS/ALERT_ALLOW_INSECURE_WEBHOOK uretimde (NODE_ENV=production) kullanilamaz");
  }
  return flags;
}

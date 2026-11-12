import { isIP } from "node:net";

/**
 * TRUST_PROXY ortam degiskenini ayristirir (inceleme I-1). Fastify'in bos "true" degeri HER atlamaya guvenir: X-Forwarded-For'un
 * SOLDAKI girdisi (istemcinin kendisinin uydurabildigi) req.ip olur; IP tabanli sinirlar asilabilir veya baskasinin IP'sine
 * karsi kullanilabilir. Sayisal "atlama sayisi" biciminin Fastify'daki anlami da beklenenden farklidir (istemciyi cozmez, soket
 * komsusunu dondurur: olculdu). Bu yuzden YALNIZCA acik bir guven siniri kabul edilir:
 *   - bos / "false" / "0"            -> kapali (varsayilan)
 *   - "127.0.0.1,::1,10.0.0.0/8"     -> guvenilen proxy IP / CIDR listesi. req.ip, X-Forwarded-For'un SAGDAN ilk
 *                                       GUVENILMEYEN girdisidir: istemcinin soldan uydurdugu girdiler yok sayilir.
 */
export function parseTrustProxy(v: string | undefined): false | string[] {
  const s = (v ?? "").trim();
  if (s === "" || s === "false" || s === "0") return false;
  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return false;
  for (const p of parts) {
    const [addr, bits, ...rest] = p.split("/");
    const family = isIP(addr ?? "");
    const max = family === 6 ? 128 : 32;
    if (!family || rest.length > 0 || (bits !== undefined && !(/^\d+$/.test(bits) && Number(bits) <= max))) {
      throw new Error(
        `TRUST_PROXY gecersiz girdi: '${p}'. Yalniz guvenilen proxy IP/CIDR listesi kabul edilir (ornek "127.0.0.1,10.0.0.0/8"); ` +
        `"true" her atlamaya guvenir (sahte X-Forwarded-For ile IP sinirlari asilir) ve sayisal bicim belirsizdir: ikisi de reddedilir.`,
      );
    }
  }
  return parts;
}

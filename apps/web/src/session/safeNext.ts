/**
 * Giris sonrasi donulecek adres: YALNIZ ayni kokenin yerel yolu (acik yonlendirme/open-redirect yok).
 * `//host`, `/\host`, mutlak URL, kontrol karakteri, kodlanmis egik cizgi, `javascript:` ve /giris dongusu reddedilir -> "/".
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/")) return "/";
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return "/";
  if (/%2f|%5c/i.test(raw)) return "/";
  if (raw === "/giris" || raw.startsWith("/giris?") || raw.startsWith("/giris/")) return "/";
  try {
    const u = new URL(raw, "http://yerel.invalid");
    if (u.origin !== "http://yerel.invalid") return "/";
  } catch {
    return "/";
  }
  return raw;
}

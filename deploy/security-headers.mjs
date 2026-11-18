/**
 * Uretim web sunumu icin guvenlik basliklari: TEK KAYNAK. deploy/nginx.example.conf ayni degerleri icerir
 * (scripts/deploy-config.test.mjs ikisinin ayni oldugunu sinar); apps/web/e2e/csp.spec.ts bu basliklarla GERCEK derlenmis paneli
 * tarayicida acip CSP ihlali olmadigini dogrular.
 */
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",   // React/uPlot satir ici style ozellikleri (yalniz oznitelik; <style> blogu ve harici stil kaynaklari kapali)
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",                // API (/api) ve SSE ayni kokenden
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

export const SECURITY_HEADERS = {
  "Content-Security-Policy": CSP,
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Frame-Options": "DENY",
};

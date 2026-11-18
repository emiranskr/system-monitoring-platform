import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { API_ORIGIN } from "./constants";
import { authFile } from "./constants";
import { SECURITY_HEADERS } from "../../../deploy/security-headers.mjs";

/**
 * Uretim sunumu SIMULASYONU: DERLENMIS panel (apps/web/dist) + deploy/security-headers.mjs basliklari + /api ters proxy.
 * Gercek Chrome'da sayfalar acilir; CSP ihlali (securitypolicyviolation) veya konsol CSP hatasi OLMAMALI.
 * On kosul: `pnpm --filter @sysmon/web build` (dist yoksa test acik hata verir).
 */
const DIST = resolve(fileURLToPath(new URL(".", import.meta.url)), "../dist");
const PORT = 18597;
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2", ".png": "image/png", ".ico": "image/x-icon" };
let server: http.Server;

test.beforeAll(async () => {
  if (!existsSync(join(DIST, "index.html"))) throw new Error("apps/web/dist yok: once `pnpm --filter @sysmon/web build` calistirin");
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname.startsWith("/api/")) {   // ters proxy: /api -> API
      const p = http.request(API_ORIGIN + url.pathname + url.search, { method: req.method, headers: { ...req.headers, host: new URL(API_ORIGIN).host, origin: `http://localhost:${PORT}` } }, (r) => {
        res.writeHead(r.statusCode ?? 502, { ...r.headers, ...SECURITY_HEADERS });
        r.pipe(res);
      });
      p.on("error", () => { res.writeHead(502); res.end(); });
      req.pipe(p);
      return;
    }
    let file = normalize(join(DIST, url.pathname));
    if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) file = join(DIST, "index.html");   // SPA yedegi
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", ...SECURITY_HEADERS });
    res.end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(PORT, "localhost", r));
});
test.afterAll(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });

test.describe("uretim basliklari ve CSP (derlenmis panel)", () => {
  test.use({ storageState: authFile("owner"), baseURL: `http://localhost:${PORT}` });

  test("panel sayfalari CSP ihlali OLMADAN acilir (filo, cihaz, uyarilar) ve basliklar ayarlidir", async ({ page }) => {
    const violations: string[] = [];
    const consoleCsp: string[] = [];
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (e) => { (window as unknown as { __v: string[] }).__v = [...((window as unknown as { __v?: string[] }).__v ?? []), `${e.violatedDirective} ${e.blockedURI}`]; });
    });
    page.on("console", (m) => { if (/content security policy|refused to/i.test(m.text())) consoleCsp.push(m.text()); });
    const resp = await page.goto("/");
    const h = resp!.headers();
    expect(h["content-security-policy"]).toBe(SECURITY_HEADERS["Content-Security-Policy"]);
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["strict-transport-security"]).toContain("max-age=");
    await expect(page.getByRole("heading", { name: /cihaz|filo|genel/i }).first()).toBeVisible();

    await page.getByRole("link", { name: /uyarılar/i }).first().click();
    await expect(page.getByRole("heading", { name: "Uyarılar" })).toBeVisible();
    await page.getByRole("tab", { name: "Kurallar" }).click();
    await expect(page.getByRole("listitem").filter({ hasText: "Cihaz çevrimdışı" })).toBeVisible();
    await page.goto("/");
    await page.getByRole("link", { name: /pc-online/ }).first().click();
    await expect(page.locator("canvas").first()).toBeVisible({ timeout: 15_000 });   // uPlot grafigi (satir ici stil) CSP altinda cizilir

    violations.push(...(await page.evaluate(() => (window as unknown as { __v?: string[] }).__v ?? [])));
    expect(violations, "CSP ihlalleri").toEqual([]);
    expect(consoleCsp, "konsol CSP hatalari").toEqual([]);
  });
});

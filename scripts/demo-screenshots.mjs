#!/usr/bin/env node
/**
 * README icin demo ekran goruntuleri (docs/img/*.png). On kosul: `pnpm demo:live` calisiyor, API (8443) ve panel (5173) ayakta.
 * Kullanim: DEMO_PASSWORD=<demo parolasi> node scripts/demo-screenshots.mjs
 * Gercek Chrome (channel: "chrome") kullanilir; tarayici indirilmez.
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "apps/web/package.json"));
const { chromium } = require("@playwright/test");
const WEB = "http://localhost:5173", API = "http://127.0.0.1:8443";
const password = process.env.DEMO_PASSWORD;
if (!password) { console.error("DEMO_PASSWORD tanimlayin (pnpm demo cikti parolasi)."); process.exit(2); }
const out = join(root, "docs/img");
mkdirSync(out, { recursive: true });

const login = await fetch(`${API}/api/v1/login`, { method: "POST", headers: { "content-type": "application/json", origin: WEB }, body: JSON.stringify({ email: "demo@example.com", password }) });
if (login.status !== 200) { console.error(`giris basarisiz: ${login.status}`); process.exit(1); }
const sid = /__Host-sid=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1];

const browser = await chromium.launch({ channel: "chrome" });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: "tr-TR", colorScheme: "dark" });
await ctx.addCookies([{ name: "__Host-sid", value: sid, domain: "localhost", path: "/", httpOnly: true, secure: true, sameSite: "Lax" }]);
const page = await ctx.newPage();
const shot = async (name) => { await page.waitForTimeout(1500); await page.screenshot({ path: join(out, `${name}.png`) }); console.log("yazildi:", `docs/img/${name}.png`); };

await page.goto(`${WEB}/`); await page.getByRole("heading", { name: "Genel bakış" }).waitFor(); await shot("genel-bakis");
await page.goto(`${WEB}/cihazlar`); await page.getByRole("link", { name: /sunucu-01/ }).first().waitFor(); await shot("cihazlar");
await page.getByRole("link", { name: /tasarim-ws-gpu/ }).first().click();
await page.locator("canvas").first().waitFor({ timeout: 20_000 });
await page.waitForTimeout(3000); await shot("cihaz-detay");
const gpuTab = page.getByRole("tab", { name: /gpu/i });
if (await gpuTab.count()) { await gpuTab.first().click(); await page.locator("canvas").first().waitFor(); await shot("cihaz-gpu"); }
await page.goto(`${WEB}/uyarilar`); await page.getByRole("heading", { name: "Uyarılar" }).waitFor(); await shot("uyarilar");
await page.getByRole("tab", { name: "Kurallar" }).click(); await shot("uyari-kurallari");
await browser.close();

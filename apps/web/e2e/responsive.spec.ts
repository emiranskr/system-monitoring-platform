import { expect, test, type Page } from "@playwright/test";
import { authFile } from "./constants";
import { open, state } from "./fixtures";

/**
 * Duyarlilik: masaustu (1280), tablet (768) ve mobil (375, dokunmatik) gorunumlerde (playwright projeleri) yatay tasma yok,
 * etkilesimli ogeler yeterince buyuk, mobilde sutunlar azalir. Proje adi: testInfo.project.name.
 */
test.use({ storageState: authFile("owner") });

const noOverflow = async (page: Page, what: string) => {
  await page.waitForTimeout(300);
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(sw, `${what}: yatay kaydirma var (scrollWidth ${sw} > clientWidth ${cw})`).toBeLessThanOrEqual(cw + 1);
};

test("yatay tasma yok: genel bakis, liste, detay (tum sekmeler), giris", async ({ page }) => {
  await open(page, "/", "Genel bakış");
  await noOverflow(page, "genel bakis");
  await open(page, "/cihazlar", "Cihazlar");
  await expect(page.getByRole("table")).toBeVisible();
  await noOverflow(page, "liste");
  await open(page, `/cihaz/${state().devices.online.id}`);
  for (const tab of ["Genel", "CPU", "Bellek", "Depolama", "Ağ", "Bilgi"]) {
    await page.getByRole("tab", { name: tab }).click();
    if (tab !== "Bilgi") await expect(page.locator("canvas").first()).toBeVisible();
    await noOverflow(page, `detay/${tab}`);
  }
});

test("yatay tasma yok: giris (oturumsuz) ve cok uzun cihaz adi", async ({ page, browser }) => {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: page.viewportSize() ?? undefined, hasTouch: test.info().project.use.hasTouch });
  const p = await ctx.newPage();
  await p.goto("/giris");
  await expect(p.getByRole("heading", { name: "Giriş" })).toBeVisible();
  await noOverflow(p, "giris");
  await ctx.close();
  // XSS adli cihaz: metin uzun, duzeni bozmamali
  await open(page, "/cihazlar", "Cihazlar");
  await expect(page.getByRole("table")).toBeVisible();
  await noOverflow(page, "liste (uzun/kotu niyetli ad)");
});

test("etkilesimli ogeler: yukseklik >= 44 px (dokunma), genislik >= 24 px (WCAG 2.2 AA)", async ({ page }) => {
  const mobile = (page.viewportSize()?.width ?? 1280) < 600;
  for (const path of ["/", "/cihazlar", `/cihaz/${state().devices.online.id}`]) {
    await open(page, path);
    await expect(page.locator("main")).toBeVisible();
    const small = await page.evaluate(() => {
      const out: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>("button, a[href], input, select, [role=tab]")) {
        if (el.closest(".sr-only") || el.classList.contains("sr-only")) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue; // gorunmeyen (hidden sutun vb.)
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none") continue;
        if (r.height < 43.5 || r.width < 24) out.push(`${el.tagName.toLowerCase()} "${(el.textContent ?? el.getAttribute("aria-label") ?? "").trim().slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
      return out;
    });
    if (mobile || (page.viewportSize()?.width ?? 0) < 1000) expect(small, `${path}: kucuk hedefler`).toEqual([]);
  }
});

test("mobilde sutunlar azalir (Bellek/Disk gizli), masaustunde tum sutunlar gorunur", async ({ page }) => {
  await open(page, "/cihazlar", "Cihazlar");
  await expect(page.getByRole("table")).toBeVisible();
  const narrow = (page.viewportSize()?.width ?? 1280) < 640;
  const mem = page.getByRole("columnheader", { name: "Bellek" });
  if (narrow) await expect(mem).toBeHidden(); else await expect(mem).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Ad" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Durum" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "CPU" })).toBeVisible();
});

test("gezinme erisilebilir: ust cubuk sarar, cikis butonu her gorunumde gorunur", async ({ page }) => {
  await open(page, "/", "Genel bakış");
  await expect(page.getByRole("navigation", { name: "Ana gezinme" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Çıkış" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Cihazlar" })).toBeVisible();
});

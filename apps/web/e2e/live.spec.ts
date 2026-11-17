import { expect, test, type Page } from "@playwright/test";
import { DEVICES, authFile } from "./constants";
import { open } from "./fixtures";

/** Arka plandaki ingest (global-setup) pc-online icin 4 sn'de bir cpu degeri gonderir; arayuz SSE ile SAYFA YENILENMEDEN gunceller. */
const cpuCell = (page: Page) => page.getByRole("row", { name: new RegExp(DEVICES.online) }).getByRole("cell").nth(2);
const banner = (page: Page) => page.getByRole("status").filter({ hasText: /canlı bağlantı kesildi/i });

/** CPU hucresi `n` sn icinde en az iki FARKLI deger gosterirse canli guncelleme calisiyordur. */
async function cpuChanges(page: Page, timeout = 30_000) {
  const seen = new Set<string>();
  await expect.poll(async () => { seen.add((await cpuCell(page).textContent())?.trim() ?? ""); return seen.size; }, { timeout, intervals: [300] }).toBeGreaterThan(1);
}

test.describe("canli guncelleme (SSE) ve kopma yonetimi (gercek tarayici EventSource)", () => {
  test.use({ storageState: authFile("owner") });

  test("yeni ornek sayfa YENILENMEDEN ekranda gorunur", async ({ page }) => {
    await open(page, "/cihazlar");
    await page.evaluate(() => { (window as unknown as { __sentinel: number }).__sentinel = 1; }); // sayfa yenilenirse kaybolur
    await cpuChanges(page, 12_000); // < 15 sn yoklama araligi: bu surede yalniz SSE degeri degistirebilir (yoklama kanit sayilmaz)
    expect(await page.evaluate(() => (window as unknown as { __sentinel?: number }).__sentinel)).toBe(1);
    await expect(banner(page)).toHaveCount(0);
  });

  test("SSE baglantisi KESILINCE bant gorunur; baglanti donunce bant kalkar ve veri akisi surer", async ({ page }) => {
    // Akis istegi agda engellenir (EventSource hata alir): kopma gercek bir ag hatasi gibi gorunur.
    await page.route("**/api/v1/stream", (route) => route.abort("connectionfailed"));
    await open(page, "/cihazlar");
    await expect(banner(page)).toBeVisible({ timeout: 15_000 });
    // yoklama canli baglanti olmadan da veriyi tazeler (15 sn): kopukken de ekran gunceldir
    await cpuChanges(page, 40_000);
    // baglanti geri geldi
    await page.unroute("**/api/v1/stream");
    await expect(banner(page)).toHaveCount(0, { timeout: 45_000 }); // geri cekilme <= ~30 sn
    await cpuChanges(page, 12_000); // yeniden baglanti sonrasi akis surer
  });
});

test.describe("canli guncelleme: salt-okunur rol", () => {
  test.use({ storageState: authFile("viewer") });

  test("viewer da canli guncellemeyi gorur (rol baginsiz)", async ({ page }) => {
    await open(page, "/cihazlar");
    await cpuChanges(page, 12_000); 
  });
});

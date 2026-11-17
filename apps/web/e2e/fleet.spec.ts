import { expect, test } from "@playwright/test";
import { DEVICES, authFile } from "./constants";
import { open, state } from "./fixtures";

test.use({ storageState: authFile("owner") });

/** Tohum: org A'da 6 cihaz (1 cevrimici, 3 cevrimdisi [XSS adli dahil], 1 bilinmiyor, 1 iptal); org B'de 1 gizli cihaz. */
test.describe("filo: genel bakis ve cihaz listesi (gercek veri)", () => {
  test("genel bakis durum sayilari veritabaniyla tutarli", async ({ page }) => {
    await open(page, "/");
    const summary = page.getByRole("region", { name: "Durum özeti" });
    const count = async (label: string) => Number((await summary.locator("div", { has: page.getByText(label, { exact: true }) }).first().locator("dd").textContent())?.trim());
    expect(await count("Çevrimiçi")).toBe(1);
    expect(await count("Bayat")).toBe(0);
    expect(await count("Çevrimdışı")).toBe(3);
    expect(await count("Bilinmiyor")).toBe(1);
    expect(await count("İptal edildi")).toBe(1);
  });

  test("baska organizasyonun cihazi HICBIR yerde gorunmez (genel bakis, liste, arama)", async ({ page }) => {
    await open(page, "/");
    await page.goto("/cihazlar");
    await expect(page.getByRole("table")).toBeVisible();
    await expect(page.getByText(DEVICES.orgB)).toHaveCount(0);
    await page.getByRole("searchbox", { name: "Cihaz ara" }).fill("gizli");
    await expect(page.getByText(/eşleşen cihaz yok/i)).toBeVisible();
  });

  test("liste: 6 satir (org B hariç); arama; durum suzgeci; siralama", async ({ page }) => {
    await open(page, "/");
    await page.goto("/cihazlar");
    const rows = page.getByRole("table").getByRole("row");
    await expect(rows).toHaveCount(7); // baslik + 6 (org A)
    await page.getByRole("searchbox", { name: "Cihaz ara" }).fill("bosluk");
    await expect(rows).toHaveCount(2);
    await page.getByRole("searchbox", { name: "Cihaz ara" }).fill("");
    await page.getByRole("combobox", { name: "Durum" }).selectOption("offline");
    await expect(rows).toHaveCount(4); // baslik + 3 cevrimdisi
    await page.getByRole("combobox", { name: "Durum" }).selectOption("all");
    await page.getByRole("button", { name: "Ad" }).click();
    await expect(page.getByRole("columnheader", { name: "Ad" })).toHaveAttribute("aria-sort", "ascending");
    const names = await page.getByRole("table").getByRole("row").nth(1).getByRole("cell").first().textContent();
    expect(names).toBeTruthy();
  });

  test("durum rozeti: renk TEK basina degil, metin gorunur (Cevrimici/Cevrimdisi/Bilinmiyor/Iptal edildi)", async ({ page }) => {
    await open(page, "/");
    await page.goto("/cihazlar");
    const table = page.getByRole("table");
    for (const label of ["Çevrimiçi", "Çevrimdışı", "Bilinmiyor", "İptal edildi"]) await expect(table.getByText(label).first()).toBeVisible();
  });

  test("liste -> cihaz detayi gezinme", async ({ page }) => {
    await open(page, "/");
    await page.goto("/cihazlar");
    await page.getByRole("link", { name: DEVICES.online }).click();
    await expect(page).toHaveURL(new RegExp(`/cihaz/${state().devices.online.id}$`));
    await expect(page.getByRole("heading", { level: 1, name: DEVICES.online })).toBeVisible();
  });

  test("XSS: kotu niyetli cihaz adi METIN olarak gorunur, script/img calismaz", async ({ page }) => {
    let dialog = false;
    page.on("dialog", (d) => { dialog = true; void d.dismiss(); });
    await open(page, "/");
    await page.goto("/cihazlar");
    await expect(page.getByText(DEVICES.evil)).toBeVisible();
    expect(await page.locator("img[src='x']").count()).toBe(0);
    await page.waitForTimeout(500);
    expect(dialog).toBe(false);
  });
});

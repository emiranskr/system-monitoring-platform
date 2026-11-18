import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { authFile } from "./constants";
import { open, state } from "./fixtures";

/** WCAG 2.x A/AA + best-practice kurallari; kritik VE ciddi ihlal sayisi 0 olmalidir (3 gorunum: masaustu, tablet, mobil). */
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

async function expectNoSeriousViolations(page: Page, what: string) {
  const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const bad = r.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
  expect(bad.map((v) => `${v.id} [${v.impact}] ${v.help}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`), `${what}: axe ihlalleri`).toEqual([]);
}

test.describe("erisilebilirlik (axe): oturumsuz", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("giris ekrani", async ({ page }) => {
    await page.goto("/giris");
    await expect(page.getByRole("heading", { level: 1, name: "Giriş" })).toBeVisible();
    await expectNoSeriousViolations(page, "giris");
  });

  test("giris hatasi gorunurken (role=alert)", async ({ page }) => {
    await page.goto("/giris");
    await page.getByLabel("E-posta").fill("yok@example.com");
    await page.getByLabel("Parola").fill("yanlis-parola-1");
    await page.getByRole("button", { name: "Giriş yap" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expectNoSeriousViolations(page, "giris hatasi");
  });

  test("klavye: Tab sirasi E-posta -> Parola -> Giris yap; odak halkasi gorunur", async ({ page }) => {
    await page.goto("/giris");
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("E-posta")).toBeFocused();
    expect(await page.getByLabel("E-posta").evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe("none");
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Parola")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Giriş yap" })).toBeFocused();
  });
});

test.describe("erisilebilirlik (axe): oturumlu ekranlar", () => {
  test.use({ storageState: authFile("admin") });

  test("genel bakis", async ({ page }) => {
    await open(page, "/", "Genel bakış");
    await expect(page.getByRole("region", { name: "Durum özeti" })).toBeVisible();
    await expectNoSeriousViolations(page, "genel bakis");
  });

  test("cihaz listesi", async ({ page }) => {
    await open(page, "/cihazlar", "Cihazlar");
    await expect(page.getByRole("table")).toBeVisible();
    await expectNoSeriousViolations(page, "cihaz listesi");
  });

  test("cihaz ekle diyalogu (token gosterilirken de)", async ({ page }) => {
    await open(page, "/cihazlar", "Cihazlar");
    await page.getByRole("button", { name: "Cihaz ekle" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg).toBeVisible();
    await expectNoSeriousViolations(page, "diyalog (form)");
    await dlg.getByRole("button", { name: "Token oluştur" }).click();
    await expect(dlg.locator("code")).toBeVisible();
    await expectNoSeriousViolations(page, "diyalog (token)");
  });

  test("diyalog klavye davranisi: odak diyalog icinde, Esc kapatir ve odak tetikleyiciye doner", async ({ page }) => {
    await open(page, "/cihazlar", "Cihazlar");
    const trigger = page.getByRole("button", { name: "Cihaz ekle" });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const dlg = page.getByRole("dialog");
    await expect(dlg).toBeVisible();
    expect(await page.evaluate(() => !!document.activeElement?.closest("[role=dialog]"))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dlg).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  for (const tab of ["Genel", "CPU", "Bellek", "Depolama", "GPU", "Ağ", "Bilgi"]) {
    test(`cihaz detayi: ${tab} sekmesi`, async ({ page }) => {
      await open(page, `/cihaz/${state().devices.online.id}`);
      await page.getByRole("tab", { name: tab }).click();
      await expect(page.getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
      if (tab !== "Bilgi") await expect(page.locator("canvas").first()).toBeVisible();
      await expectNoSeriousViolations(page, `detay/${tab}`);
    });
  }

  test("cihaz detayi: veri tablosu acikken", async ({ page }) => {
    await open(page, `/cihaz/${state().devices.online.id}`);
    await expect(page.locator("canvas").first()).toBeVisible();
    await page.getByRole("button", { name: "Tablo olarak göster" }).first().click();
    await expect(page.getByRole("table").first()).toBeVisible();
    await expectNoSeriousViolations(page, "detay/tablo");
  });

  test("hata ekrani (404)", async ({ page }) => {
    await page.goto("/cihaz/00000000-0000-4000-8000-000000000000");
    await expect(page.getByRole("alert")).toContainText("Bulunamadı");
    await expectNoSeriousViolations(page, "404");
  });

  test("klavye: 'Icerige gec' baglantisi ilk Tab'ta odaklanir ve ana alana atlar", async ({ page }) => {
    await open(page, "/cihazlar", "Cihazlar");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "İçeriğe geç" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#icerik$/);
  });
});

test.describe("erisilebilirlik (axe): uyarilar", () => {
  test.use({ storageState: authFile("owner") });

  for (const tab of ["Aktif", "Geçmiş", "Kurallar", "Kanallar"]) {
    test(`uyarilar: ${tab} sekmesi`, async ({ page }) => {
      await open(page, "/uyarilar", "Uyarılar");
      await page.getByRole("tab", { name: tab }).click();
      await expect(page.getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("main")).toBeVisible();
      await page.waitForTimeout(500);
      await expectNoSeriousViolations(page, `uyarilar/${tab}`);
    });
  }

  test("uyarilar: kural diyalogu (klavye: odak diyalogda, Esc kapatir ve odak tetikleyiciye doner)", async ({ page }) => {
    await open(page, "/uyarilar", "Uyarılar");
    await page.getByRole("tab", { name: "Kurallar" }).click();
    const trigger = page.getByRole("button", { name: /kural ekle/i });
    await trigger.click();
    const dlg = page.getByRole("dialog", { name: "Uyarı kuralı ekle" });
    await expect(dlg).toBeVisible();
    expect(await page.evaluate(() => !!document.activeElement?.closest("[role=dialog]"))).toBe(true);
    await expectNoSeriousViolations(page, "uyarilar/kural diyalogu");
    await page.keyboard.press("Escape");
    await expect(dlg).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("uyarilar: kanal diyalogu (webhook ve e-posta)", async ({ page }) => {
    await open(page, "/uyarilar", "Uyarılar");
    await page.getByRole("tab", { name: "Kanallar" }).click();
    await page.getByRole("button", { name: /kanal ekle/i }).click();
    await expect(page.getByRole("dialog", { name: "Bildirim kanalı ekle" })).toBeVisible();
    await expectNoSeriousViolations(page, "uyarilar/kanal diyalogu (webhook)");
    await page.getByLabel("Tür").selectOption("email");
    await expectNoSeriousViolations(page, "uyarilar/kanal diyalogu (e-posta)");
  });
});

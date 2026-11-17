import { expect, test } from "@playwright/test";
import { DEVICES, authFile } from "./constants";
import { open, state } from "./fixtures";

test.use({ storageState: authFile("owner") });

test.describe("cihaz detayi ve grafikler (gercek veri, gercek uPlot)", () => {
  test("baslik, durum, sekmeler ve gercek canvas grafikleri", async ({ page }) => {
    await open(page, "/");
    await page.goto(`/cihaz/${state().devices.online.id}`);
    await expect(page.getByRole("heading", { level: 1, name: DEVICES.online })).toBeVisible();
    await expect(page.getByText("Çevrimiçi").first()).toBeVisible();
    await expect(page.getByRole("tablist", { name: "Cihaz bölümleri" }).getByRole("tab")).toHaveText(["Genel", "CPU", "Bellek", "Depolama", "Ağ", "Bilgi"]);
    const cpu = page.getByRole("img", { name: "CPU kullanımı" });
    await expect(cpu.locator("canvas").first()).toBeVisible(); // uPlot GERCEKTEN canvas cizdi
    await expect(page.getByRole("img", { name: "Bellek kullanımı" }).locator("canvas").first()).toBeVisible();
  });

  test("veri tablosu: grafikle AYNI veri (API yanitindaki nokta sayisi = tablo satiri)", async ({ page }) => {
    await open(page, "/");
    const resp = page.waitForResponse((r) => r.url().includes("/metrics?") && r.url().includes("metric=cpu.total") && r.ok());
    await page.goto(`/cihaz/${state().devices.online.id}`);
    const body = (await (await resp).json()) as { points: unknown[]; source: string };
    expect(body.points.length).toBeGreaterThan(5);
    expect(body.source).toBe("raw"); // 1 sa -> ham
    const section = page.getByRole("region", { name: "CPU kullanımı" });
    await section.getByRole("button", { name: "Tablo olarak göster" }).click();
    await expect(section.getByRole("table").getByRole("row")).toHaveCount(body.points.length + 1);
  });

  test("aralik: 24 sa -> istek 24 saatlik pencere ve 1 dk katmani; 30 gun secilebilir ve grafik cizilir", async ({ page }) => {
    await open(page, "/");
    await page.goto(`/cihaz/${state().devices.online.id}`);
    await expect(page.getByRole("img", { name: "CPU kullanımı" }).locator("canvas").first()).toBeVisible();
    const resp = page.waitForResponse((r) => r.url().includes("/metrics?") && r.url().includes("metric=cpu.total") && Math.abs(Date.parse(new URL(r.url()).searchParams.get("to")!) - Date.parse(new URL(r.url()).searchParams.get("from")!) - 86400_000) < 1000);
    await page.getByRole("button", { name: "24 sa" }).click();
    const j = (await (await resp).json()) as { source: string; points: unknown[] };
    expect(j.source).toBe("1m");
    expect(j.points.length).toBeGreaterThan(100);
    await expect(page.getByRole("button", { name: "24 sa" })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "30 gün" }).click();
    await expect(page.getByRole("img", { name: "CPU kullanımı" }).locator("canvas").first()).toBeVisible();
  });

  test("klavye alternatifi: Uzaklastir/Yakinlastir araligi onayarlar arasinda degistirir", async ({ page }) => {
    await open(page, "/");
    await page.goto(`/cihaz/${state().devices.online.id}`);
    await page.getByRole("button", { name: "Uzaklaştır" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "6 sa" })).toHaveAttribute("aria-pressed", "true");
  });

  test("BOSLUK = KESINTI: 20 dk'lik bosluk grafikte null olarak (cizgi kesik), duzenli seride bosluk yok", async ({ page }) => {
    await open(page, "/");
    await page.goto(`/cihaz/${state().devices.gap.id}`);
    const cpu = page.getByRole("img", { name: "CPU kullanımı" });
    await expect(cpu.locator("canvas").first()).toBeVisible();
    await expect(cpu).toHaveAttribute("data-gaps", "1");
    await page.goto(`/cihaz/${state().devices.online.id}`);
    await expect(page.getByRole("img", { name: "CPU kullanımı" }).locator("canvas").first()).toBeVisible();
    await expect(page.getByRole("img", { name: "CPU kullanımı" })).toHaveAttribute("data-gaps", "0");
  });

  test("Ag sekmesi: adaptor adi device_info'dan, KB/s biriminde ozet; Depolama: disk grafigi", async ({ page }) => {
    await open(page, "/");
    await page.goto(`/cihaz/${state().devices.online.id}`);
    await page.getByRole("tab", { name: "Ağ" }).click();
    await expect(page.getByRole("heading", { name: "Ethernet" })).toBeVisible();
    const rx = page.getByRole("region", { name: "Ethernet alınan" });
    await expect(rx.locator("canvas").first()).toBeVisible();
    await expect(rx).toContainText("KB/s");
    await page.getByRole("tab", { name: "Depolama" }).click();
    await expect(page.getByRole("img", { name: "Disk C: doluluk" }).locator("canvas").first()).toBeVisible();
  });

  test("olmayan metrik: veri olmayan cihazda 'Bu donanimda yok', sifir cizilmez", async ({ page }) => {
    await open(page, "/");
    await page.goto(`/cihaz/${state().devices.gap.id}`); // yalniz cpu+bellek verisi var
    await page.getByRole("tab", { name: "Ağ" }).click();
    await expect(page.getByText(/bu donanımda yok/i)).toBeVisible();
    await page.getByRole("tab", { name: "Depolama" }).click();
    await expect(page.getByText(/bu donanımda yok/i)).toBeVisible();
  });

  test("Bilgi sekmesi: device_info", async ({ page }) => {
    await open(page, "/");
    await page.goto(`/cihaz/${state().devices.online.id}`);
    await page.getByRole("tab", { name: "Bilgi" }).click();
    await expect(page.getByText("Windows 11")).toBeVisible();
    await expect(page.getByText("0.1.0")).toBeVisible();
  });

  test("olmayan cihaz ve BASKA ORG'un cihazi AYNI 'Bulunamadi' ekrani (varlik ipucu yok)", async ({ page }) => {
    await open(page, "/");
    await page.goto("/cihaz/00000000-0000-4000-8000-000000000000");
    await expect(page.getByRole("alert")).toContainText("Bulunamadı");
    const missing = await page.getByRole("alert").innerText();
    await page.goto(`/cihaz/${state().devices.orgB.id}`);
    await expect(page.getByRole("alert")).toContainText("Bulunamadı");
    expect(await page.getByRole("alert").innerText()).toBe(missing);
    await expect(page.getByText(DEVICES.orgB)).toHaveCount(0);
  });
});

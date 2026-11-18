import http from "node:http";
import { expect, test } from "@playwright/test";
import { WEB_ORIGIN, DEVICES, authFile } from "./constants";
import { open } from "./fixtures";

/**
 * Uyarilar: GERCEK backend (degerlendirici 1 sn, kuyruk 1 sn) + gercek tarayici + gercek HTTP webhook alicisi.
 * Akis: kanal (API ile; panel yerel http hedefini istemcide reddeder, uretim davranisi) -> kural (ARAYUZ) -> esik asilir -> olay panelde
 * gorunur -> webhook bildirimi imzali ve tek kez gelir -> kanal testi -> kural devre disi/silme.
 */
const PORT = 18598;
let hits: { headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
let receiver: http.Server;

test.beforeAll(async () => {
  receiver = http.createServer((req, res) => {
    const c: Buffer[] = [];
    req.on("data", (d) => c.push(d));
    req.on("end", () => { try { hits.push({ headers: req.headers, body: JSON.parse(Buffer.concat(c).toString()) }); } catch { /* bozuk */ } res.end("ok"); });
  });
  await new Promise<void>((r) => receiver.listen(PORT, "127.0.0.1", r));
});
test.afterAll(async () => { receiver.closeAllConnections(); await new Promise((r) => receiver.close(r)); });

test.describe("uyari sistemi (owner)", () => {
  test.use({ storageState: authFile("owner") });

  test("kural olustur -> olay gorunur -> imzali webhook TEK kez -> kanal testi -> devre disi birak -> sil", async ({ page }) => {
    hits = [];
    await open(page, "/uyarilar", "Uyarılar");

    // Kanal: API (oturum cerezi + izinli Origin); gizli alanlar panelde hic gorunmez.
    const ch = await page.request.post("/api/v1/notification-channels", {
      headers: { origin: WEB_ORIGIN },
      data: { type: "webhook", name: "E2E alici", url: `http://127.0.0.1:${PORT}/hook/GIZLI-TOKEN`, secret: "e2e-imza" },
    });
    expect(ch.status()).toBe(201);
    const chId = (await ch.json()).id as string;

    try {
      // Kanallar sekmesi: yalniz ana makine gorunur
      await page.reload();
      await page.getByRole("tab", { name: "Kanallar" }).click();
      await expect(page.getByText(/Webhook · 127\.0\.0\.1/)).toBeVisible();
      await expect(page.locator("body")).not.toContainText("GIZLI-TOKEN");
      await expect(page.locator("body")).not.toContainText("e2e-imza");

      // Kural: ARAYUZDEN (esik 1: seed edilen cevrimici cihazin CPU'su surekli > 1)
      await page.getByRole("tab", { name: "Kurallar" }).click();
      await page.getByRole("button", { name: /kural ekle/i }).click();
      const dlg = page.getByRole("dialog", { name: "Uyarı kuralı ekle" });
      await dlg.getByLabel("Kural adı").fill("E2E CPU");
      await dlg.getByLabel("Toplama").selectOption("max");
      await dlg.getByLabel("Eşik").fill("1");
      await dlg.getByLabel("Pencere (sn)").fill("15");
      await dlg.getByLabel("Süre (sn)").fill("0");
      await dlg.getByLabel("Önem").selectOption("critical");
      await dlg.getByRole("checkbox", { name: "E2E alici" }).check();
      await dlg.getByRole("button", { name: "Kaydet" }).click();
      await expect(dlg).toHaveCount(0);
      await expect(page.getByRole("listitem").filter({ hasText: "E2E CPU" })).toContainText("Kritik");

      // Olay: Aktif sekmesinde (yoklama/yenileme ile) gorunur
      await page.getByRole("tab", { name: "Aktif" }).click();
      const row = page.getByRole("row").filter({ hasText: "E2E CPU" }).filter({ hasText: DEVICES.online });
      await expect(async () => {
        await page.reload();
        await expect(row).toBeVisible({ timeout: 2000 });
      }).toPass({ timeout: 30_000 });
      await expect(row).toContainText("Kritik");

      // Webhook: imzali, TEK firing bildirimi (birkac tur beklense de mukerrer yok)
      await expect.poll(() => hits.filter((h) => h.body.kind === "firing" && h.body.rule_name === "E2E CPU" && h.body.device_name === DEVICES.online).length, { timeout: 20_000 }).toBe(1);
      await page.waitForTimeout(4000);
      const firing = hits.filter((h) => h.body.kind === "firing" && h.body.rule_name === "E2E CPU" && h.body.device_name === DEVICES.online);
      expect(firing).toHaveLength(1);
      expect(firing[0]!.headers["x-sysmon-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
      expect(firing[0]!.body).toMatchObject({ severity: "critical", metric: "cpu.total" });

      // Kanal testi
      await page.getByRole("tab", { name: "Kanallar" }).click();
      await page.getByRole("button", { name: /test gönder/i }).click();
      await expect(page.getByRole("status")).toContainText("kuyruğa alındı");
      await expect.poll(() => hits.some((h) => h.body.kind === "test"), { timeout: 20_000 }).toBe(true);

      // Devre disi birak: acik olay sessizce kapanir
      await page.getByRole("tab", { name: "Kurallar" }).click();
      const li = page.getByRole("listitem").filter({ hasText: "E2E CPU" });
      await li.getByRole("button", { name: /devre dışı bırak/i }).click();
      await expect(li).toContainText("Devre dışı");
      await page.getByRole("tab", { name: "Aktif" }).click();
      await expect(async () => {
        await page.reload();
        await expect(page.getByRole("row").filter({ hasText: "E2E CPU" })).toHaveCount(0, { timeout: 2000 });
      }).toPass({ timeout: 20_000 });

      // Sil (iki adimli onay)
      await page.getByRole("tab", { name: "Kurallar" }).click();
      await li.getByRole("button", { name: /^sil/i }).click();
      await li.getByRole("button", { name: /evet, sil/i }).click();
      await expect(li).toHaveCount(0);
    } finally {
      await page.request.delete(`/api/v1/notification-channels/${chId}`, { headers: { origin: WEB_ORIGIN } });
    }
  });

  test("yerlesik kurallar listede; silinemez (Sil dugmesi yok), devre disi birakilabilir", async ({ page }) => {
    await open(page, "/uyarilar", "Uyarılar");
    await page.getByRole("tab", { name: "Kurallar" }).click();
    for (const n of ["Cihaz çevrimdışı", "Disk dolu", "Sürekli yüksek CPU", "Sürekli yüksek bellek"]) {
      const li = page.getByRole("listitem").filter({ hasText: n });
      await expect(li).toBeVisible();
      await expect(li).toContainText("Yerleşik");
      await expect(li.getByRole("button", { name: /^sil/i })).toHaveCount(0);
    }
  });
});

test.describe("uyari sistemi (viewer)", () => {
  test.use({ storageState: authFile("viewer") });

  test("viewer okur ama yazma kontrolu goremez; API yazmayi 403 ile reddeder", async ({ page }) => {
    await open(page, "/uyarilar", "Uyarılar");
    await page.getByRole("tab", { name: "Kurallar" }).click();
    await expect(page.getByRole("listitem").filter({ hasText: "Cihaz çevrimdışı" })).toBeVisible();
    await expect(page.getByRole("button", { name: /kural ekle/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /devre dışı bırak/i })).toHaveCount(0);
    await page.getByRole("tab", { name: "Kanallar" }).click();
    await expect(page.getByRole("button", { name: /kanal ekle/i })).toHaveCount(0);
    const r = await page.request.post("/api/v1/alert-rules", { headers: { origin: WEB_ORIGIN }, data: { name: "x", metric: "cpu.total", agg: "avg", window_seconds: 60, operator: ">", threshold: 1, for_seconds: 0, severity: "info" } });
    expect(r.status()).toBe(403);
  });
});

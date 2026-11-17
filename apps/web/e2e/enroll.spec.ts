import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { API_ORIGIN, authFile } from "./constants";
import { open, sql } from "./fixtures";

const NEW_DEVICE = "e2e-yeni-pc";

test.describe("Cihaz ekle (enrollment token, gercek backend): salt-okunur rol", () => {
  test.use({ storageState: authFile("viewer") });

  test("viewer icin dugme yok", async ({ page }) => {
    await open(page, "/cihazlar");
    await expect(page.getByRole("table")).toBeVisible();
    await expect(page.getByRole("button", { name: "Cihaz ekle" })).toHaveCount(0);
  });
});

test.describe("Cihaz ekle (enrollment token, gercek backend): yonetici", () => {
  test.use({ storageState: authFile("admin") });

  // Bu test kalici bir cihaz olusturur; sonraki spec'lerin (filo sayilari) bozulmamasi icin TEMIZLENIR.
  test.afterEach(async () => {
    const ids = (await sql<{ id: string }>("SELECT id FROM devices WHERE name=$1", [NEW_DEVICE])).map((r) => r.id);
    for (const id of ids) {
      for (const t of ["device_tokens", "device_ingest_state", "enrollments"]) await sql(`DELETE FROM ${t} WHERE device_id=$1`, [id]);
      await sql("UPDATE enrollment_tokens SET device_id=NULL WHERE device_id=$1", [id]);
      await sql("DELETE FROM devices WHERE id=$1", [id]);
    }
  });

  test("token uretir, YALNIZ bir kez gorur, kapatinca kaybolur; token ile gercek ajan kaydi calisir ve cihaz listede gorunur", async ({ page, request }) => {
    await open(page, "/cihazlar");
    await page.getByRole("button", { name: "Cihaz ekle" }).click();
    const dlg = page.getByRole("dialog", { name: /cihaz ekle/i });
    await dlg.getByRole("button", { name: "Token oluştur" }).click();
    const token = (await dlg.locator("code").textContent())!.trim();
    expect(token.length).toBeGreaterThanOrEqual(43);
    await expect(dlg.getByText(/yalnızca şimdi görüntülenir/i)).toBeVisible();

    // GERCEK ajan kaydi (API dogrudan): token tek kullanimlik
    const body = { token, enroll_id: randomUUID(), machine_guid: `guid-${randomUUID()}`,
      device_info: { hostname: NEW_DEVICE, os: "Windows 11", agent_version: "0.1.0", gpus: [], adapters: [{ id: "eth0", name: "Ethernet" }], volumes: [{ id: "C", name: "C:" }] } };
    const enroll = await request.post(`${API_ORIGIN}/agent/v1/enroll`, { data: body });
    expect(enroll.status()).toBe(200);
    const again = await request.post(`${API_ORIGIN}/agent/v1/enroll`, { data: { ...body, enroll_id: randomUUID(), machine_guid: `guid-${randomUUID()}` } });
    expect(again.status()).toBe(401); // tek kullanimlik

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await page.content()).not.toContain(token); // DOM'da kalmaz
    await page.getByRole("button", { name: "Cihaz ekle" }).click();
    await expect(page.getByRole("dialog").locator("code")).toHaveCount(0); // yeniden acilinca yok
    await page.keyboard.press("Escape");

    await page.reload();
    await expect(page.getByRole("link", { name: NEW_DEVICE })).toBeVisible(); // yeni cihaz listede
  });

  test("gecersiz TTL: istemci dogrulamasi", async ({ page }) => {
    await open(page, "/cihazlar");
    await page.getByRole("button", { name: "Cihaz ekle" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel(/geçerlilik/i).fill("4");
    await dlg.getByRole("button", { name: "Token oluştur" }).click();
    await expect(dlg.getByRole("alert")).toContainText("5 ile 1440");
  });
});

import { expect, test } from "@playwright/test";
import { USERS } from "./constants";
import { login, sql } from "./fixtures";

/** GERCEK backend: giris formu -> Vite proxy -> API -> TimescaleDB. */
test.describe("giris ve oturum", () => {
  test("yanlis parola: hata mesaji, oturum acilmaz", async ({ page }) => {
    await page.goto("/giris");
    await page.getByLabel("E-posta").fill(USERS.owner);
    await page.getByLabel("Parola").fill("yanlis-parola-123");
    await page.getByRole("button", { name: "Giriş yap" }).click();
    await expect(page.getByRole("alert")).toContainText("E-posta veya parola hatalı");
    await expect(page).toHaveURL(/\/giris/);
  });

  test("dogru giris: genel bakis acilir, kabukta kullanici ve cikis gorunur", async ({ page }) => {
    await login(page, USERS.owner);
    await expect(page.getByText(USERS.owner)).toBeVisible();
    await expect(page.getByRole("button", { name: "Çıkış" })).toBeVisible();
  });

  test("oturumsuz korumali sayfa -> girise, giristen sonra hedef sayfaya doner", async ({ page }) => {
    await page.goto("/cihazlar");
    await expect(page).toHaveURL(/\/giris\?next=%2Fcihazlar/);
    await page.getByLabel("E-posta").fill(USERS.owner);
    await page.getByLabel("Parola").fill("e2e-test-parola-12345");
    await page.getByRole("button", { name: "Giriş yap" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Cihazlar" })).toBeVisible();
    await expect(page).toHaveURL(/\/cihazlar$/);
  });

  test("dis 'next' (https://kotu.example) yok sayilir: girisden sonra ana sayfa", async ({ page }) => {
    await page.goto("/giris?next=https%3A%2F%2Fkotu.example");
    await page.getByLabel("E-posta").fill(USERS.owner);
    await page.getByLabel("Parola").fill("e2e-test-parola-12345");
    await page.getByRole("button", { name: "Giriş yap" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Genel bakış" })).toBeVisible();
    expect(new URL(page.url()).origin).toBe(new URL("http://localhost:5199").origin);
  });

  test("cikis: girise doner, geri gidince korumali sayfa acilmaz", async ({ page }) => {
    await login(page, USERS.viewer);
    await page.getByRole("button", { name: "Çıkış" }).click();
    await expect(page).toHaveURL(/\/giris/);
    await page.goto("/cihazlar");
    await expect(page).toHaveURL(/\/giris/);
  });

  test("oturum veritabanindan SILININCE arayuz sonraki sorguda (yoklama <= 15 sn) girise doner", async ({ page }) => {
    await login(page, USERS.revoke); // ortak storageState oturumlarini etkilememek icin ayri kullanici
    await sql("DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email=$1)", [USERS.revoke]);
    // Onbellekteki taze veri aninda gosterilir; oturum kaybi bir sonraki /devices yoklamasinda (401) fark edilir.
    await page.getByRole("link", { name: "Cihazlar" }).click();
    await expect(page).toHaveURL(/\/giris/, { timeout: 25_000 });
    await expect(page.getByRole("heading", { name: "Giriş" })).toBeVisible();
  });
});

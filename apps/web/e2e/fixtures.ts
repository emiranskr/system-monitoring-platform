import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import pg from "pg";
import { E2E_PASSWORD, STATE_FILE, type E2EState } from "./constants";

export const state = (): E2EState => JSON.parse(readFileSync(STATE_FILE, "utf8")) as E2EState;

/** Gecici veritabanina dogrudan SQL (testlerin arka plan manipulasyonlari: oturum silme, temizlik vb.). */
export async function sql<T = unknown>(query: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: state().dbUrl });
  await c.connect();
  try { return (await c.query(query, params)).rows as T[]; } finally { await c.end(); }
}

/** Arayuzden giris yapar (gercek giris formu) ve genel bakisin yuklenmesini bekler. Giris AKISINI sinayan testlerde kullanilir. */
export async function login(page: Page, email: string, password = E2E_PASSWORD): Promise<void> {
  await page.goto("/giris");
  await page.getByLabel("E-posta").fill(email);
  await page.getByLabel("Parola").fill(password);
  await page.getByRole("button", { name: "Giriş yap" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Genel bakış" })).toBeVisible();
}

/** Oturumlu (storageState) bir sayfaya gider ve giris ekranina dusmedigini dogrular. */
export async function open(page: Page, path: string, heading?: string | RegExp): Promise<void> {
  await page.goto(path);
  await expect(page).not.toHaveURL(/\/giris/);
  if (heading) await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
}

import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { API_ORIGIN, DEVICES, authFile } from "./constants";
import { open, state } from "./fixtures";

/**
 * Ornekten EKRANA gecikme (M3 kabul: LAN'da p95 < 10 sn): agent protokoluyla gercek ingest -> API -> SSE -> tarayici -> ekranda deger.
 * Olcum, ornegin API'ye gonderildigi andan ekranda gorundugu ana kadardir. KAPSAM DISI: ajanin ornek toplama/batch yasi
 * (gercek ajan ornegi batch aralig kadar bekletir) ve ag gecikmesi (tek makine). Bu nedenle sonuc "sunucu + tarayici" katkisidir.
 */
test.use({ storageState: authFile("owner") });

const N = 30;
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]!;

/**
 * Panelde cpu degeri gorunur mu? Arka plandaki ingest akisi AYNI cihaza yazar ve panel "son gelen degeri" gosterir: isaretli ornegimizden hemen sonra
 * arka plan ornegi gelirse isaretli deger hic cizilmeyebilir (son-yazan-kazanir yarisi; yavas CI kosucularinda goruldu). Bu durumda false doner ve
 * cagiran ayni isareti yeniden gonderir.
 */
async function cpuShows(page: Page, text: string, timeout = 6_000): Promise<boolean> {
  return page.waitForFunction(
    ([name, want]) => {
      const row = [...document.querySelectorAll("tr")].find((r) => r.textContent?.includes(name as string));
      return row?.querySelectorAll("td")[2]?.textContent?.trim() === want;
    },
    [DEVICES.online, text] as const,
    { polling: "raf", timeout },
  ).then(() => true, () => false);
}

test("ornekten ekrana gecikme: p95 < 10 sn (SSE ile), sonuc raporlanir", async ({ page, request }) => {
  test.setTimeout(180_000);
  await open(page, "/cihazlar", "Cihazlar");
  await expect(page.getByRole("table")).toBeVisible();
  // canli akis baglandi mi (banner yok) ve ilk olay bekleniyor
  await page.waitForTimeout(1500);

  const epoch = randomUUID();
  const token = state().devices.online.token;
  const lat: number[] = [];
  let resends = 0;
  let seq = 0;
  for (let i = 0; i < N; i++) {
    const marker = 70 + (i % 29); // arka plan ingest'in araligi (20-60) disinda: karismaz
    const text = `%${marker}`;
    let shown = false;
    let t0 = 0;
    for (let attempt = 0; attempt < 4 && !shown; attempt++) {   // yaris halinde (bkz. cpuShows) AYNI isaret yeniden gonderilir; gecikme SON gonderimden olculur
      if (attempt > 0) resends++;
      const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      const body = gzipSync(Buffer.from(JSON.stringify({ v: 1, spool_epoch: epoch, seq: seq++, sent_at: ts, samples: [{ ts, m: { "cpu.total": marker } }] })));
      t0 = Date.now();
      const r = await request.post(`${API_ORIGIN}/agent/v1/ingest`, { headers: { "content-type": "application/json", "content-encoding": "gzip", authorization: `Bearer ${token}` }, data: body });
      expect(r.status()).toBe(200);
      shown = await cpuShows(page, text);
    }
    expect(shown, `ornek ${i}: isaret 4 denemede de ekranda gorunmedi`).toBe(true);
    lat.push(Date.now() - t0);
    await page.waitForTimeout(400);
  }

  const result = {
    olcum: "ingest istegi gonderimi -> ekranda cpu degerinin gorunmesi (SSE)", ornek: N, birim: "ms",
    yeniden_gonderim: resends,
    p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), max: Math.max(...lat), min: Math.min(...lat),
    butce_ms: 10_000, gecti: pct(lat, 95) < 10_000,
    sinirlar: "Tek makine (API, DB, Vite, tarayici ayni yerde); agent ornek toplama/batch yasi ve gercek ag gecikmesi DAHIL DEGIL; SSE yolu (yoklama degil). Resmi olcum degildir.",
    tarih: new Date().toISOString(),
  };
  const dir = new URL("../../../docs/ilerleme/kanit/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL(`m3b-latency-${N}ornek.json`, dir), JSON.stringify(result, null, 2) + "\n");
  console.log("GECIKME", JSON.stringify(result));
  expect(result.p95, "p95 gecikme butcesi (10 sn)").toBeLessThan(10_000);
});

// M3a ON OLCUM (resmi B6 DEGIL): ingest yuku SURERKEN (a) grafik sorgusu gecikmesi (B-6: 24 sa p95 < 500 ms, 30 gun p95 < 1 sn),
// (b) ingest -> SSE olay gecikmesi (sunucu katkisi; "ornekten ekrana p95 < 10 sn" butcesinin bir parcasi).
// Uyari: yuk uretici, API ve DB AYNI makinede; gecmis veri kucuk olcekli (varsayilan 6 cihaz x 29 gun x 12 metrik), uretim olcegi
// (500 cihaz x 30 gun) DEGIL. Kullanim: node tools/bench/query-bench.mjs [yuk_cihaz=200] [sorgu_sayisi=120] [gecmis_cihaz=6]
// On kosul: pnpm -r build; Docker TimescaleDB calisiyor.
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { createTestDb } from "../../packages/db/dist/testing.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOAD = Number(process.argv[2] ?? 200), QUERIES = Number(process.argv[3] ?? 120), HIST = Number(process.argv[4] ?? 6);
const PORT = 18444, ORIGIN = "http://localhost:5173", PW = "bench-parola-123456";
const METRICS = Array.from({ length: 30 }, (_, i) => `bench.m${String(i).padStart(2, "0")}`);
const HIST_METRICS = ["cpu.total", "mem.used_pct", ...Array.from({ length: 10 }, (_, i) => `hist.m${i}`)];
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : null);
const stats = (a) => ({ n: a.length, p50: pct(a, 50), p95: pct(a, 95), p99: pct(a, 99), max: a.length ? Math.max(...a) : null });
const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "number" ? Math.round(v * 10) / 10 : v]));

const db = await createTestDb();
const api = spawn(process.execPath, [join(root, "apps/api/dist/server.js")], {
  env: { ...process.env, DATABASE_URL: db.url, CREDENTIAL_KEY: randomBytes(32).toString("base64"), PORT: String(PORT), LOG_LEVEL: "warn", ALLOWED_ORIGINS: ORIGIN },
  stdio: ["ignore", "ignore", "pipe"],
});
let setupToken = "";
api.stderr.on("data", (c) => { const m = /: (\S{40,})\s*$/m.exec(String(c)); if (m) setupToken = m[1]; else process.stderr.write(c); });
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 80 && !setupToken; i++) await sleep(250);
if (!setupToken) throw new Error("setup token alinamadi");

const out = { baslangic: new Date().toISOString(), yukCihaz: LOAD, gecmisCihaz: HIST, sorguSayisi: QUERIES };
try {
  const post = (path, body, cookie) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const setup = await post("/api/v1/setup", { token: setupToken, email: "bench@example.com", password: PW });
  if (setup.status !== 201) throw new Error(`setup ${setup.status}`);
  const login = await post("/api/v1/login", { email: "bench@example.com", password: PW });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const org = (await db.pool.query("SELECT org_id FROM users LIMIT 1")).rows[0].org_id;

  const mkDevice = async (name) => {
    const id = (await db.pool.query("INSERT INTO devices (org_id, name) VALUES ($1,$2) RETURNING id", [org, name])).rows[0].id;
    const token = "bench_" + randomBytes(24).toString("base64url");
    await db.pool.query("INSERT INTO device_tokens (token_hash, org_id, device_id) VALUES ($1,$2,$3)", [createHash("sha256").update(token).digest(), org, id]);
    return { id, token, epoch: randomUUID(), seq: 0 };
  };
  const target = await mkDevice("hedef");
  const hist = [target, ...(await Promise.all(Array.from({ length: HIST - 1 }, (_, i) => mkDevice(`gecmis${i}`))))];
  const loaders = await Promise.all(Array.from({ length: LOAD }, (_, i) => mkDevice(`yuk${i}`)));
  const probe = await mkDevice("sonda");

  // Gecmis: 29 gun, dakikada bir ham ornek (1 dk katmani icin), sonra katmani yenile.
  const t0 = Date.now();
  const end = new Date(Math.floor(Date.now() / 60000) * 60000 - 5 * 60000), start = new Date(end.getTime() - 29 * 86400000);
  // Toplu gecmis yukleme, arka plandaki Timescale isleriyle (cagg yenileme/saklama) chunk kilidinde ARADA deadlock olabilir (40P01):
  // bu yalnizca bu olcum betiginin yapay toplu yuklemesine ozgudur; yeniden denenir.
  for (const d of hist) {
    for (let attempt = 1; ; attempt++) {
      try {
        await db.pool.query(
          `INSERT INTO metric_samples (ts, org_id, device_id, metric, value)
           SELECT t, $1, $2, m, (extract(epoch from t)::bigint / 60 % 100)
             FROM generate_series($3::timestamptz, $4::timestamptz, interval '1 minute') t, unnest($5::text[]) m
           ON CONFLICT DO NOTHING`,
          [org, d.id, start, end, HIST_METRICS]);
        break;
      } catch (e) {
        if (e.code !== "40P01" || attempt >= 6) throw e;
        await sleep(1000 * attempt);
      }
    }
  }
  await db.pool.query("CALL refresh_continuous_aggregate('metric_1m', $1::timestamptz, $2::timestamptz)", [new Date(start.getTime() - 3600000), new Date(end.getTime() + 60000)]);
  // Uretimde 3 gunden eski katman chunk'lari sikistirilir (0003 politikasi); kisa olcumde politika calismaz: elle sikistir ki olcum gercekci olsun.
  const chunks = (await db.pool.query("SELECT show_chunks('metric_1m', older_than => interval '3 days') AS c")).rows;
  let compressedChunks = 0;
  for (const c of chunks) {
    try { await db.pool.query("SELECT compress_chunk($1::regclass, if_not_compressed => true)", [c.c]); compressedChunks++; } catch (e) { if (!/already compressed/.test(e.message)) throw e; }
  }
  out.katmanSikistirilanChunk = compressedChunks;
  out.gecmisHazirlamaSn = Math.round((Date.now() - t0) / 1000);
  out.gecmisSatir = Number((await db.pool.query("SELECT count(*) FROM metric_samples")).rows[0].count);

  // Yuk: her cihaz 5 sn'de bir batch (5 ornek x 30 metrik), baslangiclar dagitilir (bench.mjs ile ayni).
  let stop = false;
  const sendBatch = (d, samples) => fetch(base + "/agent/v1/ingest", {
    method: "POST", headers: { "content-type": "application/json", "content-encoding": "gzip", authorization: `Bearer ${d.token}` },
    body: gzipSync(Buffer.from(JSON.stringify({ v: 1, spool_epoch: d.epoch, seq: d.seq++, sent_at: iso(new Date()), samples }))),
  });
  const loadStatuses = new Map();
  const loadLoop = async (d, i) => {
    await sleep((i * 5000) / Math.max(1, LOAD));
    while (!stop) {
      const now = new Date();
      const samples = Array.from({ length: 5 }, (_, k) => ({ ts: iso(new Date(now.getTime() - (4 - k) * 1000)), m: Object.fromEntries(METRICS.map((m, j) => [m, (j * 7 + k) % 100])) }));
      try { const r = await sendBatch(d, samples); loadStatuses.set(r.status, (loadStatuses.get(r.status) ?? 0) + 1); await r.arrayBuffer(); } catch { loadStatuses.set("hata", (loadStatuses.get("hata") ?? 0) + 1); }
      await sleep(5000);
    }
  };
  const loads = loaders.map(loadLoop);
  await sleep(15_000); // yukun oturmasi

  // (a) Grafik sorgulari (ingest yuku SURERKEN)
  const timeQuery = async (label, spanMs, n) => {
    const lat = [], bad = [];
    for (let i = 0; i < n; i++) {
      const to = new Date(Date.now() - 6 * 60000), from = new Date(to.getTime() - spanMs);
      const url = `${base}/api/v1/devices/${target.id}/metrics?metric=${i % 2 ? "cpu.total" : "mem.used_pct"}&from=${from.toISOString()}&to=${to.toISOString()}&max_points=600`;
      const s = performance.now();
      const r = await fetch(url, { headers: { cookie } });
      const j = await r.json();
      lat.push(performance.now() - s);
      if (r.status !== 200 || !Array.isArray(j.points) || j.points.length === 0) bad.push(r.status);
    }
    out[label] = { ...round(stats(lat)), hatali: bad.length };
  };
  await timeQuery("sorgu_24sa_ms", 24 * 3600000, QUERIES);
  await timeQuery("sorgu_30gun_ms", 28 * 86400000, QUERIES);
  await timeQuery("sorgu_1sa_ham_ms", 3600000, QUERIES);

  // Filo listesi
  const fleet = [];
  for (let i = 0; i < 30; i++) { const s = performance.now(); const r = await fetch(`${base}/api/v1/devices`, { headers: { cookie } }); await r.arrayBuffer(); fleet.push(performance.now() - s); }
  out.filo_listesi_ms = round(stats(fleet));
  out.filo_cihaz_sayisi = HIST + LOAD + 1;

  // (b) ingest -> SSE olay gecikmesi (sunucu katkisi): sonda her 2 sn gonderir, deger = gonderim zamani (ms)
  const sseLat = [];
  const ac = new AbortController();
  const sse = await fetch(`${base}/api/v1/stream?devices=${probe.id}`, { headers: { cookie }, signal: ac.signal });
  (async () => {
    let buf = "";
    for await (const chunk of sse.body) {
      buf += Buffer.from(chunk).toString("utf8");
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const m = /^data: (.*)$/m.exec(block);
        if (/^event: sample/m.test(block) && m) { const v = JSON.parse(m[1]).values["probe.sent_ms"]; if (typeof v === "number") sseLat.push(Date.now() - v); }
      }
    }
  })().catch(() => {});
  for (let i = 0; i < 40; i++) {
    const sent = Date.now();
    await sendBatch(probe, [{ ts: iso(new Date()), m: { "probe.sent_ms": sent } }]).then((r) => r.arrayBuffer());
    await sleep(2000);
  }
  await sleep(1000);
  ac.abort();
  out.sse_gecikme_ms = round(stats(sseLat));

  stop = true;
  await Promise.all(loads);
  out.yukDurumlari = Object.fromEntries(loadStatuses);
  out.bitis = new Date().toISOString();

  const verdict = (v, lim) => (v == null ? "OLCULEMEDI" : v < lim ? "GECTI" : "KACTI");
  out.degerlendirme = {
    "B-6 24sa p95 < 500 ms": verdict(out.sorgu_24sa_ms.p95, 500),
    "B-6 30gun p95 < 1000 ms": verdict(out.sorgu_30gun_ms.p95, 1000),
    "SSE sunucu katkisi p95 < 10000 ms (butcenin yalniz bir parcasi)": verdict(out.sse_gecikme_ms.p95, 10000),
  };
  out.sinirlar = "Tek makine (yuk uretici+API+DB ayni yerde); gecmis veri kucuk olcekli; resmi B6/B-6 DEGIL; SSE rakami yalniz sunucu katkisidir (agent ornekleme/batch yasi ve tarayici cizimi dahil degil).";
} finally {
  api.kill();
  await db.drop();
}
mkdirSync(join(root, "docs/ilerleme/kanit"), { recursive: true });
const file = join(root, `docs/ilerleme/kanit/m3a-query-bench-${LOAD}cihaz.json`);
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
console.log("yazildi:", file);
process.exit(0);

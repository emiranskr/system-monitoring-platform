// M2 ON OLCUM (resmi B6 DEGIL): N sahte cihaz, 5 sn'de bir batch (5 ornek x 30 metrik = 150 satir), gercek API sureci +
// gercek Docker TimescaleDB. Uyari: yuk uretici, API ve DB AYNI makinede calisir; sayilar o makinenin tavanidir, uretim
// kapasitesi degildir. Kullanim: node tools/bench/bench.mjs [basamaklar=10,50,100,250,500] [sure_sn=45]
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { createTestDb } from "../../packages/db/dist/testing.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const steps = (process.argv[2] ?? "10,50,100,250,500").split(",").map(Number);
const durSec = Number(process.argv[3] ?? 45);
const PORT = 18443;
const METRICS = Array.from({ length: 30 }, (_, i) => `bench.m${String(i).padStart(2, "0")}`);
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : null);

const db = await createTestDb();
const cpuOf = (pid) => Number(execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).TotalProcessorTime.TotalSeconds`]).toString().trim().replace(",", "."));
const rssOf = (pid) => Math.round(Number(execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).WorkingSet64`]).toString().trim()) / 1048576);
const dockerStats = () => {
  try { return execFileSync("docker", ["stats", "--no-stream", "--format", "{{.CPUPerc}} | {{.MemUsage}}", "deploy-db-1"]).toString().trim(); } catch { return "?"; }
};

const api = spawn(process.execPath, [join(root, "apps/api/dist/server.js")], {
  env: { ...process.env, DATABASE_URL: db.url, CREDENTIAL_KEY: randomBytes(32).toString("base64"), PORT: String(PORT), LOG_LEVEL: "warn" },
  stdio: ["ignore", "ignore", "inherit"],
});
for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${PORT}/yok`); break; } catch { await sleep(250); } }

const results = [];
try {
  let made = 0;
  const devices = [];
  const ensure = async (n) => {
    while (devices.length < n) {
      const org = (await db.pool.query("INSERT INTO orgs (name) VALUES ('bench') RETURNING id")).rows[0].id;
      const id = (await db.pool.query("INSERT INTO devices (org_id, name) VALUES ($1,$2) RETURNING id", [org, `b${made++}`])).rows[0].id;
      const token = "bench_" + randomBytes(24).toString("base64url");
      await db.pool.query("INSERT INTO device_tokens (token_hash, org_id, device_id) VALUES ($1,$2,$3)", [createHash("sha256").update(token).digest(), org, id]);
      devices.push({ id, token, epoch: crypto.randomUUID(), seq: 0 });
    }
  };

  for (const n of steps) {
    await ensure(n);
    await db.pool.query("TRUNCATE metric_samples");
    const lat = [], statuses = new Map();
    let sent = 0, stop = false;
    const cpu0 = cpuOf(api.pid), t0 = Date.now();
    const tick = async (d) => {
      const now = new Date();
      const samples = Array.from({ length: 5 }, (_, i) => ({
        ts: iso(new Date(now.getTime() - (4 - i) * 1000)),
        m: Object.fromEntries(METRICS.map((m, j) => [m, (j * 7 + i) % 100])),
      }));
      const body = gzipSync(Buffer.from(JSON.stringify({ v: 1, spool_epoch: d.epoch, seq: d.seq++, sent_at: iso(now), samples })));
      const s = performance.now();
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/agent/v1/ingest`, {
          method: "POST", body, headers: { "content-type": "application/json", "content-encoding": "gzip", authorization: `Bearer ${d.token}` },
        });
        await r.arrayBuffer();
        lat.push(performance.now() - s);
        statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
      } catch { statuses.set("hata", (statuses.get("hata") ?? 0) + 1); }
      sent++;
    };
    const timers = devices.slice(0, n).map((d) => {
      let iv;
      const start = setTimeout(() => { void tick(d); iv = setInterval(() => { if (!stop) void tick(d); }, 5000); }, Math.random() * 5000);
      return () => { clearTimeout(start); clearInterval(iv); };
    });
    await sleep((durSec / 2) * 1000);
    const dockerMid = dockerStats();
    await sleep((durSec / 2) * 1000);
    stop = true; timers.forEach((c) => c());
    await sleep(1500);
    const secs = (Date.now() - t0) / 1000;
    const cpuPct = ((cpuOf(api.pid) - cpu0) / secs) * 100; // tek cekirdegin yuzdesi
    lat.sort((a, b) => a - b);
    const rows = Number((await db.pool.query("SELECT count(*) FROM metric_samples")).rows[0].count);
    const size = Number((await db.pool.query("SELECT hypertable_size('metric_samples') AS s")).rows[0].s);
    const ok = statuses.get(200) ?? 0;
    const r = {
      cihaz: n, sure_sn: Math.round(secs), istek: sent, basarili_200: ok, durumlar: Object.fromEntries(statuses),
      istek_sn: +(sent / secs).toFixed(1), satir_sn: +(rows / secs).toFixed(0), satir: rows,
      p50_ms: +pct(lat, 50)?.toFixed(1), p95_ms: +pct(lat, 95)?.toFixed(1), p99_ms: +pct(lat, 99)?.toFixed(1), maks_ms: +lat.at(-1)?.toFixed(1),
      api_cpu_tek_cekirdek_yuzde: +cpuPct.toFixed(0), api_rss_mb: rssOf(api.pid), db_konteyner_orta: dockerMid,
      tablo_boyut_mb: +(size / 1048576).toFixed(1), bayt_satir: rows ? +(size / rows).toFixed(0) : null,
    };
    results.push(r);
    console.log(JSON.stringify(r));
  }

  // Toplu yeniden baglanma firtinasi (B-?): kesinti sonrasi TUM cihazlar biriken batch'lerini AYNI ANDA bosaltir (her cihaz stop-and-wait).
  if (process.argv[5] === "storm") {
    const nStorm = steps.at(-1), backlog = 12;
    await ensure(nStorm);
    await db.pool.query("TRUNCATE metric_samples");
    const sl = [], sst = new Map();
    const t0 = Date.now();
    await Promise.all(devices.slice(0, nStorm).map(async (d) => {
      for (let b = 0; b < backlog; b++) {
        const base = Date.now() - 600_000 + b * 5000;
        const samples = Array.from({ length: 5 }, (_, i) => ({ ts: iso(new Date(base + i * 1000)), m: Object.fromEntries(METRICS.map((m, j) => [m, (j * 7 + i) % 100])) }));
        const body = gzipSync(Buffer.from(JSON.stringify({ v: 1, spool_epoch: d.epoch, seq: d.seq++, sent_at: iso(new Date()), samples })));
        const s = performance.now();
        try {
          const r = await fetch(`http://127.0.0.1:${PORT}/agent/v1/ingest`, { method: "POST", body, headers: { "content-type": "application/json", "content-encoding": "gzip", authorization: `Bearer ${d.token}` } });
          await r.arrayBuffer();
          sl.push(performance.now() - s);
          sst.set(r.status, (sst.get(r.status) ?? 0) + 1);
        } catch { sst.set("hata", (sst.get("hata") ?? 0) + 1); }
      }
    }));
    const secs = (Date.now() - t0) / 1000;
    sl.sort((a, b) => a - b);
    const rows = Number((await db.pool.query("SELECT count(*) FROM metric_samples")).rows[0].count);
    const r = {
      firtina: true, cihaz: nStorm, batch_cihaz: backlog, istek: nStorm * backlog, sure_sn: +secs.toFixed(1), istek_sn: +((nStorm * backlog) / secs).toFixed(0),
      durumlar: Object.fromEntries(sst), p50_ms: +pct(sl, 50)?.toFixed(1), p95_ms: +pct(sl, 95)?.toFixed(1), p99_ms: +pct(sl, 99)?.toFixed(1), maks_ms: +sl.at(-1)?.toFixed(1),
      satir: rows, beklenen_satir: nStorm * backlog * 150, api_rss_mb: rssOf(api.pid),
    };
    results.push(r);
    console.log(JSON.stringify(r));
  }
} finally {
  api.kill();
  await sleep(500);
  await db.drop();
}
mkdirSync(join(root, "docs/ilerleme/kanit"), { recursive: true });
const out = join(root, "docs/ilerleme/kanit", process.argv[4] ?? "m2-on-olcum.json");
writeFileSync(out, JSON.stringify({ not: "ON OLCUM: yuk uretici+API+DB ayni makinede; resmi B6 degil", tarih: new Date().toISOString(), adim_sure_sn: durSec, sonuclar: results }, null, 2));
console.log("yazildi:", out);

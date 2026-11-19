#!/usr/bin/env node
/**
 * SERGI/DEMO verisi: yerel gelistirme veritabanina (deploy/.env DATABASE_URL) inandirici bir demo organizasyonu basar.
 *   pnpm build && pnpm demo            -> tohum (idempotent: tekrar calistirmak demo verisini SIFIRDAN kurar, baska org'lara dokunmaz)
 *   pnpm demo:live                     -> tohum + calisan API'ye (varsayilan http://127.0.0.1:8443) 5 sn'de bir canli olcum gonderir (Ctrl-C ile durur)
 * Demo kullanicisi: demo@example.com, parola HER CALISTIRMADA rastgele uretilir ve YALNIZ burada yazdirilir (depoda sabit parola YOK).
 * Yalniz YEREL demo icindir; uretim veritabanina karsi calistirmayin.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const live = process.argv.includes("--live");
const apiArg = process.argv.indexOf("--api");
const API = apiArg > 0 ? process.argv[apiArg + 1] : "http://127.0.0.1:8443";
const DEMO_ORG = "Demo Şirketi";
const DEMO_EMAIL = "demo@example.com";
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

const GPU = "gpu-46139694-b075-6c98-9b95-3b6f3a465823";   // NVML UUID tabanli CanonicalId (M4)
/** Cihazlar: ad, profil (deterministik sentetik egriler), son gorulme (ms once; null = hic gorulmedi), canli mi. */
const DEVICES = [
  { name: "ofis-pc-01", cpu: 28, mem: 52, disk: 61, net: 2_000_000, live: true },
  { name: "tasarim-ws-gpu", cpu: 55, mem: 71, disk: 74, net: 6_000_000, gpu: true, live: true },
  { name: "sunucu-01", cpu: 93, mem: 83, disk: 92, net: 12_000_000, live: true, hot: true },   // yuksek CPU + disk dolu -> uyari uretir
  { name: "laptop-ahmet", cpu: 20, mem: 48, disk: 58, net: 800_000, offlineMs: 3 * 3600_000 }, // 3 saattir gorunmuyor -> cevrimdisi
  { name: "yeni-cihaz", never: true },                                                          // kayit edilmis, hic veri gondermemis
];

const wave = (t, period, amp, phase = 0) => Math.sin((t / period) * 2 * Math.PI + phase) * amp;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/** t: ms. Deterministik (rastgele degil): ayni t icin ayni deger; gercekci dalgalanma. */
function sample(d, t, i) {
  const s = t / 1000;
  const cpu = clamp(d.cpu + wave(s, 900, 9, i) + wave(s, 97, 4, i * 2) + wave(s, 13, 2), 1, 100);
  const m = {
    "cpu.total": Math.round(cpu * 10) / 10,
    "mem.used_pct": Math.round(clamp(d.mem + wave(s, 3600, 4, i), 5, 99) * 10) / 10,
    "disk.c.used_pct": Math.round((d.disk + wave(s, 86400, 0.3)) * 10) / 10,
    "net.eth0.rx_bps": Math.round(clamp(d.net * (1 + wave(s, 600, 0.5, i)) + wave(s, 17, d.net * 0.1), 100, 1e9)),
    "net.eth0.tx_bps": Math.round(clamp(d.net * 0.4 * (1 + wave(s, 420, 0.5, i + 1)), 100, 1e9)),
  };
  if (d.gpu) {
    const u = clamp(40 + wave(s, 300, 35, i) + wave(s, 31, 8), 0, 100);
    m[`gpu.${GPU}.util_pct`] = Math.round(u * 10) / 10;
    m[`gpu.${GPU}.vram_used_bytes`] = Math.round((3.5 + u / 100 * 4) * 1024 ** 3);
    m[`gpu.${GPU}.temp_c`] = Math.round(clamp(45 + u * 0.4, 30, 95));
  }
  return m;
}

async function main() {
  const { devDatabaseUrl } = await imp("packages/db/dist/testing.js");
  const { migrate, pg } = await imp("packages/db/dist/index.js");
  const { hashPassword } = await imp("apps/api/dist/password.js");
  const pool = new pg.Pool({ connectionString: devDatabaseUrl(), max: 4 });
  pool.on("error", () => undefined);
  const q = (sql, p = []) => pool.query(sql, p);
  try {
    console.log("migrate:", await migrate(pool));
    // --- demo organizasyonunu SIFIRDAN kur (yalniz demo org'unun satirlari silinir) ---
    let org = (await q("SELECT id FROM orgs WHERE name = $1", [DEMO_ORG])).rows[0]?.id;
    if (org) {
      for (const t of ["notifications", "incidents", "alert_state", "alert_rules", "notification_channels", "metric_samples", "device_ingest_state",
        "device_tokens", "enrollments", "enrollment_tokens", "devices", "sessions", "audit_events", "users"]) {
        await q(`DELETE FROM ${t} WHERE org_id = $1`, [org]);
      }
    } else {
      org = (await q("INSERT INTO orgs (name) VALUES ($1) RETURNING id", [DEMO_ORG])).rows[0].id;
    }
    const password = randomBytes(9).toString("base64url");   // 12 karakter
    await q("INSERT INTO users (org_id, email, password_hash, role) VALUES ($1,$2,$3,'owner')", [org, DEMO_EMAIL, await hashPassword(password)]);

    // --- cihazlar ---
    const now = Date.now();
    const info = (hostname, gpu) => JSON.stringify({ hostname, os: "Windows 11 Pro", agent_version: "0.1.0",
      gpus: gpu ? [{ canonical_id: GPU, name: "NVIDIA RTX 4070" }] : [],
      adapters: [{ id: "eth0", name: "Ethernet" }], volumes: [{ id: "c", name: "C:" }] });
    const devs = [];
    for (const [i, d] of DEVICES.entries()) {
      const lastSeen = d.never ? null : new Date(now - (d.offlineMs ?? 1000));
      const id = (await q("INSERT INTO devices (org_id, name, last_seen_at, device_info) VALUES ($1,$2,$3,$4) RETURNING id", [org, d.name, lastSeen, info(d.name, d.gpu)])).rows[0].id;
      const token = "demo_" + randomBytes(24).toString("base64url");
      await q("INSERT INTO device_tokens (token_hash, org_id, device_id) VALUES ($1,$2,$3)", [createHash("sha256").update(token).digest(), org, id]);
      devs.push({ ...d, id, token, i });
    }

    // --- gecmis veri: son 3 sa 5 sn aralikli (ham) + onceki 24 sa 1 dk'da bir; cevrimdisi cihaz kesildigi ana kadar ---
    let rows = 0;
    for (const d of devs.filter((x) => !x.never)) {
      const end = now - (d.offlineMs ?? 5000);
      const batch = [];
      for (let t = end - 27 * 3600_000; t <= end; t += t > end - 3 * 3600_000 ? 5_000 : 60_000) {
        for (const [metric, value] of Object.entries(sample(d, t, d.i))) batch.push([new Date(t), org, d.id, metric, value]);
      }
      for (let k = 0; k < batch.length; k += 4000) {
        const part = batch.slice(k, k + 4000);
        await q(`INSERT INTO metric_samples (ts, org_id, device_id, metric, value)
                 SELECT * FROM unnest($1::timestamptz[], $2::uuid[], $3::uuid[], $4::text[], $5::float8[]) ON CONFLICT DO NOTHING`,
          [part.map((r) => r[0]), part.map((r) => r[1]), part.map((r) => r[2]), part.map((r) => r[3]), part.map((r) => r[4])]);
      }
      rows += batch.length;
    }
    const minute = 60_000;
    await q("CALL refresh_continuous_aggregate('metric_1m', $1::timestamptz, $2::timestamptz)", [new Date(now - 28 * 3600_000), new Date(Math.floor(now / minute) * minute - minute)]);

    // --- uyari kurali + olaylar (gecmis cozulmus + su an acik) ---
    const rule = (await q(
      `INSERT INTO alert_rules (org_id, name, metric, agg, window_seconds, operator, threshold, hysteresis, for_seconds, severity)
       VALUES ($1,'Demo: yüksek CPU','cpu.total','avg',60,'>',85,3,0,'critical') RETURNING id`, [org])).rows[0].id;
    const hot = devs.find((x) => x.hot), laptop = devs.find((x) => x.offlineMs);
    const incident = (dev, opened, resolved, last, peak, sev = "critical") => q(
      `INSERT INTO incidents (org_id, rule_id, device_id, rule_name, device_name, metric, severity, opened_at, resolved_at, last_value, peak_value)
       VALUES ($1,$2,$3,'Demo: yüksek CPU',$4,'cpu.total',$5,$6,$7,$8,$9)`,
      [org, rule, dev.id, dev.name, sev, new Date(opened), resolved ? new Date(resolved) : null, last, peak]);
    await incident(laptop, now - 5 * 3600_000, now - 4.7 * 3600_000, 72, 94, "warning");   // gecmis, cozulmus
    await incident(hot, now - 40 * minute, null, 93.4, 97.1);                               // su an ACIK

    console.log(`\nDemo verisi hazir: ${devs.length} cihaz, ${rows} olcum satiri, 1 kural, 2 olay.`);
    console.log("Giris:  http://localhost:5173/giris");
    console.log(`  e-posta : ${DEMO_EMAIL}`);
    console.log(`  parola  : ${password}     (yalniz bu calistirmada gosterilir; yeniden calistirirsaniz yeni parola uretilir)`);

    if (!live) { console.log("\nCanli akis icin: pnpm demo:live (API calisiyor olmali)."); return; }

    // --- canli mod: calisan API'ye 5 sn'de bir olcum gonder (cevrimici cihazlar) ---
    console.log(`\nCanli mod: ${API} adresine olcum gonderiliyor (Ctrl-C ile durdur). Ilk gonderimde API erisilemezse yeniden denenir.`);
    const epoch = randomUUID();
    let seq = 0;
    const tick = async () => {
      const t = Date.now();
      for (const d of devs.filter((x) => x.live)) {
        const body = gzipSync(Buffer.from(JSON.stringify({ v: 1, spool_epoch: `${epoch.slice(0, -2)}${String(d.i).padStart(2, "0")}`, seq, sent_at: iso(new Date(t)), samples: [{ ts: iso(new Date(t)), m: sample(d, t, d.i) }] })));
        try {
          const r = await fetch(`${API}/agent/v1/ingest`, { method: "POST", headers: { "content-type": "application/json", "content-encoding": "gzip", authorization: `Bearer ${d.token}` }, body });
          if (!r.ok && seq % 12 === 0) console.log(`  ingest ${d.name}: HTTP ${r.status}`);
        } catch { if (seq % 12 === 0) console.log(`  API'ye ulasilamadi (${API}); API'yi baslatin.`); }
      }
      seq++;
    };
    await tick();
    const timer = setInterval(() => void tick(), 5000);
    await new Promise((res) => { process.on("SIGINT", res); process.on("SIGTERM", res); });
    clearInterval(timer);
  } finally {
    await pool.end();
  }
}
await main();

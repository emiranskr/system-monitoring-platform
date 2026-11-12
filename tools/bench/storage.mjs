// M2 depolama olcumu: gercekci karisik metrik dagilimiyla satir basina bayt (siksitirmasiz ve siksitirilmis) + 1 dk agrega boyutu,
// ardindan 500 cihaz icin gunluk hacim ve kalici durum toplam boyut PROJEKSIYONU. Gercek Docker TimescaleDB, gecici veritabani.
// Kullanim: node tools/bench/storage.mjs [cihaz=5] [saat=6]
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { createTestDb } from "../../packages/db/dist/testing.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const nDev = Number(process.argv[2] ?? 5), hours = Number(process.argv[3] ?? 6);
const db = await createTestDb();
const q = (s, p) => db.pool.query(s, p);
try {
  const org = (await q("INSERT INTO orgs (name) VALUES ('st') RETURNING id")).rows[0].id;
  for (let i = 0; i < nDev; i++) await q("INSERT INTO devices (org_id, name) VALUES ($1,$2)", [org, `d${i}`]);

  // 30 metrik: 10 gurultulu yuzde (tam hassasiyetli double), 5 yavas degisen, 5 sabit, 5 patlamali ag sayaci, 5 bayt sayaci
  const kinds = [["walk", 10], ["slow", 5], ["const", 5], ["burst", 5], ["bytes", 5]];
  const metrics = kinds.flatMap(([k, c]) => Array.from({ length: c }, (_, i) => ({ k, name: `bench.${k}${String(i).padStart(2, "0")}` })));
  await q("CREATE TEMP TABLE mm (name text, kind text)");
  for (const m of metrics) await q("INSERT INTO mm VALUES ($1,$2)", [m.name, m.k]);

  const t0 = Date.now();
  await q(
    `INSERT INTO metric_samples (ts, org_id, device_id, metric, value)
     SELECT t, d.org_id, d.id, mm.name,
       CASE mm.kind
         WHEN 'walk'  THEN greatest(0, least(100, 30 + 25*sin(extract(epoch from t)/600 + row_number_n) + (random()-0.5)*8))
         WHEN 'slow'  THEN 40 + row_number_n + floor(extract(epoch from t)/120)*0.01
         WHEN 'const' THEN 17179869184 + row_number_n
         WHEN 'burst' THEN CASE WHEN random() < 0.1 THEN floor(random()*5000000) ELSE floor(random()*2000) END
         ELSE 8000000000 + floor(extract(epoch from t)/30)*4096 + floor(random()*65536)
       END
     FROM generate_series(now() - $1::int * interval '1 hour' - interval '30 hours', now() - interval '30 hours', interval '1 second') t
     CROSS JOIN (SELECT id, org_id, row_number() OVER () AS row_number_n FROM devices) d
     CROSS JOIN mm`,
    [hours],
  );
  const insertSec = (Date.now() - t0) / 1000;
  const rows = Number((await q("SELECT count(*) FROM metric_samples")).rows[0].count);
  const rawSize = Number((await q("SELECT hypertable_size('metric_samples') s")).rows[0].s);

  const chunks = (await q("SELECT show_chunks('metric_samples') c")).rows;
  for (const c of chunks) await q("SELECT compress_chunk($1::regclass, if_not_compressed => true)", [c.c]);
  const cmpSize = Number((await q("SELECT hypertable_size('metric_samples') s")).rows[0].s);

  const lo = (await q("SELECT min(ts) m FROM metric_samples")).rows[0].m, hi = (await q("SELECT max(ts) m FROM metric_samples")).rows[0].m;
  await q("CALL refresh_continuous_aggregate('metric_1m', $1::timestamptz, $2::timestamptz)", [lo, new Date(hi.getTime() + 120_000)]);
  const mat = (await q("SELECT materialization_hypertable_schema s, materialization_hypertable_name n FROM timescaledb_information.continuous_aggregates WHERE view_name='metric_1m'")).rows[0];
  const aggRows = Number((await q("SELECT count(*) FROM metric_1m")).rows[0].count);
  const aggSize = Number((await q("SELECT hypertable_size(format('%I.%I',$1::text,$2::text)::regclass) s", [mat.s, mat.n])).rows[0].s);

  // Agrega da sikistirilabilir (TimescaleDB): olc
  await q("ALTER MATERIALIZED VIEW metric_1m SET (timescaledb.compress = true)");
  const matReg = `${mat.s}.${mat.n}`;
  for (const c of (await q("SELECT show_chunks($1::regclass) c", [matReg])).rows) await q("SELECT compress_chunk($1::regclass, if_not_compressed => true)", [c.c]);
  const aggCmpSize = Number((await q("SELECT hypertable_size($1::regclass) s", [matReg])).rows[0].s);

  const GB = 1024 ** 3;
  const rawBpr = rawSize / rows, cmpBpr = cmpSize / rows, aggBpr = aggSize / aggRows, aggCmpBpr = aggCmpSize / aggRows;
  const proj = (devices, intervalSec, unCmpDays = 2, aggCompressed = false) => {
    const seriesPerDay = devices * 30;
    const rowsDay = seriesPerDay * (86400 / intervalSec);
    const aggDay = seriesPerDay * 1440;
    const rawDayGB = (rowsDay * rawBpr) / GB, cmpDayGB = (rowsDay * cmpBpr) / GB, aggDayGB = (aggDay * (aggCompressed ? aggCmpBpr : aggBpr)) / GB;
    return {
      cihaz: devices, ornek_araligi_sn: intervalSec, siksitirmasiz_pencere_gun: unCmpDays, agrega_siksitirilmis: aggCompressed, satir_gun_milyon: +(rowsDay / 1e6).toFixed(0),
      ham_siksitirmasiz_GB_gun: +rawDayGB.toFixed(1), ham_siksitirilmis_GB_gun: +cmpDayGB.toFixed(1), agrega_1dk_GB_gun: +aggDayGB.toFixed(2),
      // kalici durum: ham = 2 gun siksitirmasiz + 1 gun siksitirilmis (compress_after 2 gun, drop_after 3 gun) + 30 gun 1 dk agrega
      kalici_toplam_GB: +(unCmpDays * rawDayGB + (3 - unCmpDays) * cmpDayGB + 30 * aggDayGB).toFixed(0),
    };
  };
  const out = {
    not: "SENTETIK ama karisik dagilim; gercek makine verisiyle siksitirma orani farkli olabilir. Projeksiyon dogrusal.",
    olcum: { cihaz: nDev, saat: hours, satir: rows, ekleme_sn: +insertSec.toFixed(0),
      bayt_satir_siksitirmasiz: +rawBpr.toFixed(1), bayt_satir_siksitirilmis: +cmpBpr.toFixed(1), siksitirma_orani: +(rawBpr / cmpBpr).toFixed(1),
      agrega_satir: aggRows, agrega_bayt_satir: +aggBpr.toFixed(1), agrega_siksitirilmis_bayt_satir: +aggCmpBpr.toFixed(1) },
    projeksiyon: [proj(500, 1), proj(500, 5), proj(500, 5, 0.5, true), proj(500, 5, 2, true), proj(500, 10, 0.5, true), proj(500, 15)],
    butce: { "B-3a_siksitirmasiz_GB_gun": 15, "B-3b_siksitirilmis_GB_gun": 5, "B-4_agrega_GB_gun": 2, "B-5_toplam_GB": 150 },
  };
  console.log(JSON.stringify(out, null, 2));
  mkdirSync(join(root, "docs/ilerleme/kanit"), { recursive: true });
  writeFileSync(join(root, "docs/ilerleme/kanit/m2-depolama-olcumu.json"), JSON.stringify(out, null, 2));
} finally {
  await db.drop();
}

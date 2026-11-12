// GERCEK veriyle siksitirma olcumu: bu makinede calisan gercek .NET agent (Debug, loopback http) 1 sn orneklemeyle gercek API'ye
// ve gercek TimescaleDB'ye veri yollar; sonra ham chunk'lar ve 1 dk agrega siksitirilip satir basina bayt olculur.
// Kullanim: node tools/bench/real-compress.mjs [sure_sn=600]
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createTestDb } from "../../packages/db/dist/testing.js";
import { buildApp } from "../../apps/api/dist/app.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const exe = join(root, "agent/windows/src/Agent.Service/bin/Debug/net10.0-windows/Agent.Service.exe");
const durSec = Number(process.argv[2] ?? 600);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const db = await createTestDb();
const dir = mkdtempSync(join(tmpdir(), "sysmon-real-"));
let agent, app;
try {
  const org = (await db.pool.query("INSERT INTO orgs (name) VALUES ('real') RETURNING id")).rows[0].id;
  const dev = (await db.pool.query("INSERT INTO devices (org_id, name) VALUES ($1,'real') RETURNING id", [org])).rows[0].id;
  const token = "tok_real_" + "ab12cd34ef56".repeat(5);
  await db.pool.query("INSERT INTO device_tokens (token_hash, org_id, device_id) VALUES ($1,$2,$3)", [createHash("sha256").update(token).digest(), org, dev]);
  writeFileSync(join(dir, "b.txt"), token, "ascii");
  const imp = spawnSync(exe, ["--import-token", join(dir, "b.txt"), "--data-dir", dir], { encoding: "utf8" });
  if (imp.status !== 0) throw new Error("token import basarisiz: " + imp.stdout + imp.stderr);

  app = buildApp({ pool: db.pool, credentialKey: Buffer.alloc(32, 1), sampleIntervalSeconds: 1 });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = app.server.address().port;
  agent = spawn(exe, ["--server", `http://127.0.0.1:${port}`, "--allow-insecure-loopback", "--data-dir", dir], { stdio: "ignore" });
  console.log(`gercek agent ${durSec} sn calisiyor...`);
  await sleep(durSec * 1000);
  agent.kill();
  await sleep(1500);

  const q = (s, p) => db.pool.query(s, p);
  const rows = Number((await q("SELECT count(*) FROM metric_samples")).rows[0].count);
  const series = Number((await q("SELECT count(DISTINCT metric) FROM metric_samples")).rows[0].count);
  const nulls = Number((await q("SELECT count(*) FROM metric_samples WHERE value IS NULL")).rows[0].count);
  const distinctVals = Number((await q("SELECT count(DISTINCT value) FROM metric_samples")).rows[0].count);
  const rawSize = Number((await q("SELECT hypertable_size('metric_samples') s")).rows[0].s);
  for (const c of (await q("SELECT show_chunks('metric_samples') c")).rows) await q("SELECT compress_chunk($1::regclass, if_not_compressed => true)", [c.c]);
  const cmpSize = Number((await q("SELECT hypertable_size('metric_samples') s")).rows[0].s);

  const lo = (await q("SELECT min(ts) m FROM metric_samples")).rows[0].m, hi = (await q("SELECT max(ts) m FROM metric_samples")).rows[0].m;
  await q("CALL refresh_continuous_aggregate('metric_1m', $1::timestamptz, $2::timestamptz)", [lo, new Date(hi.getTime() + 120_000)]);
  const mat = (await q("SELECT materialization_hypertable_schema s, materialization_hypertable_name n FROM timescaledb_information.continuous_aggregates WHERE view_name='metric_1m'")).rows[0];
  const matReg = `${mat.s}.${mat.n}`;
  const aggRows = Number((await q("SELECT count(*) FROM metric_1m")).rows[0].count);
  const aggSize = Number((await q("SELECT hypertable_size($1::regclass) s", [matReg])).rows[0].s);
  for (const c of (await q("SELECT show_chunks($1::regclass) c", [matReg])).rows) await q("SELECT compress_chunk($1::regclass, if_not_compressed => true)", [c.c]);
  const aggCmp = Number((await q("SELECT hypertable_size($1::regclass) s", [matReg])).rows[0].s);

  const out = {
    not: "GERCEK ajan verisi (tek makine), kisa sure. Kucuk hacimde sabit ek yuk oran ustunde etkilidir; olcum yon gostericidir.",
    sure_sn: durSec, satir: rows, seri_sayisi: series, null_orani: +(nulls / rows).toFixed(3), farkli_deger_sayisi: distinctVals,
    bayt_satir_siksitirmasiz: +(rawSize / rows).toFixed(1), bayt_satir_siksitirilmis: +(cmpSize / rows).toFixed(1), siksitirma_orani: +(rawSize / cmpSize).toFixed(1),
    agrega_satir: aggRows, agrega_bayt_satir: +(aggSize / aggRows).toFixed(1), agrega_siksitirilmis_bayt_satir: +(aggCmp / aggRows).toFixed(1),
  };
  console.log(JSON.stringify(out, null, 2));
  mkdirSync(join(root, "docs/ilerleme/kanit"), { recursive: true });
  writeFileSync(join(root, "docs/ilerleme/kanit/m2-gercek-veri-siksitirma.json"), JSON.stringify(out, null, 2));
} finally {
  try { agent?.kill(); } catch { /* yok */ }
  await sleep(500);
  await app?.close().catch(() => undefined);
  await db.drop();
  rmSync(dir, { recursive: true, force: true });
}

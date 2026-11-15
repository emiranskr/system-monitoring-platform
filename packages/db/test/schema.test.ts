import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/index.js";
import { createTestDb, type TestDb } from "../src/testing.js";

let db: TestDb;
let orgA: string, orgB: string, devA: string, devB: string;

beforeAll(async () => {
  db = await createTestDb();
  orgA = (await db.pool.query("INSERT INTO orgs (name) VALUES ('A') RETURNING id")).rows[0].id;
  orgB = (await db.pool.query("INSERT INTO orgs (name) VALUES ('B') RETURNING id")).rows[0].id;
  devA = (await db.pool.query("INSERT INTO devices (org_id, name) VALUES ($1,'a1') RETURNING id", [orgA])).rows[0].id;
  devB = (await db.pool.query("INSERT INTO devices (org_id, name) VALUES ($1,'b1') RETURNING id", [orgB])).rows[0].id;
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

const insertSample = (ts: string, org: string, dev: string, metric: string, value: number | null) =>
  db.pool.query(
    "INSERT INTO metric_samples (ts, org_id, device_id, metric, value) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (device_id, metric, ts) DO NOTHING",
    [ts, org, dev, metric, value],
  );

describe("migration", () => {
  it("yeniden calistirmak zararsizdir (uygulanmis olanlari atlar)", async () => {
    expect(await migrate(db.pool)).toEqual([]);
  });
});

describe("kisitlar", () => {
  it("metric_samples bir hypertable'dir", async () => {
    const r = await db.pool.query("SELECT count(*)::int AS n FROM timescaledb_information.hypertables WHERE hypertable_name='metric_samples'");
    expect(r.rows[0].n).toBe(1);
  });

  it("yinelenen (cihaz, metrik, zaman) insert idempotenttir", async () => {
    const ts = "2026-11-12T10:00:00Z";
    await insertSample(ts, orgA, devA, "cpu.total", 10);
    await insertSample(ts, orgA, devA, "cpu.total", 99); // ayni anahtar: yok sayilir, ilk deger kalir
    const r = await db.pool.query("SELECT value FROM metric_samples WHERE device_id=$1 AND metric='cpu.total' AND ts=$2", [devA, ts]);
    expect(r.rows).toEqual([{ value: 10 }]);
  });

  it("baska organizasyonun cihazina bagli ornek yapisal olarak reddedilir (bilesik FK)", async () => {
    await expect(insertSample("2026-11-12T10:00:05Z", orgA, devB, "cpu.total", 1)).rejects.toMatchObject({ code: "23503" });
  });

  it("baska organizasyonu baglayan token reddedilir (bilesik FK)", async () => {
    await expect(
      db.pool.query("INSERT INTO device_tokens (token_hash, org_id, device_id) VALUES (decode(repeat('ab',32),'hex'), $1, $2)", [orgA, devB]),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("token ozeti 32 bayt olmak zorundadir (ham token saklanamaz)", async () => {
    await expect(
      db.pool.query("INSERT INTO device_tokens (token_hash, org_id, device_id) VALUES ('\\x6162', $1, $2)", [orgA, devA]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("NULL deger (kullanilamiyor) saklanabilir", async () => {
    await insertSample("2026-11-12T10:00:10Z", orgA, devA, "gpu.temp", null);
    const r = await db.pool.query("SELECT value FROM metric_samples WHERE metric='gpu.temp'");
    expect(r.rows[0].value).toBeNull();
  });
});

describe("continuous aggregate (1 dk)", () => {
  it("elle hesaplanan degerlerle eslesir; NULL sayilmaz", async () => {
    const d = (await db.pool.query("INSERT INTO devices (org_id, name) VALUES ($1,'agg') RETURNING id", [orgA])).rows[0].id;
    const base = "2026-11-10T08:00:";
    for (const [s, v] of [["05", 1], ["20", 2], ["50", 6]] as const) await insertSample(`${base}${s}Z`, orgA, d, "mem.used_pct", v);
    await insertSample("2026-11-10T08:00:55Z", orgA, d, "mem.used_pct", null); // sayilmaz
    await insertSample("2026-11-10T08:01:10Z", orgA, d, "mem.used_pct", 10);

    await db.pool.query("CALL refresh_continuous_aggregate('metric_1m', '2026-11-10T07:59:00Z', '2026-11-10T08:05:00Z')");

    const r = await db.pool.query(
      "SELECT to_char(bucket AT TIME ZONE 'UTC','HH24:MI') AS b, avg_value, min_value, max_value, n::int AS n FROM metric_1m WHERE device_id=$1 AND metric='mem.used_pct' ORDER BY bucket",
      [d],
    );
    expect(r.rows).toEqual([
      { b: "08:00", avg_value: 3, min_value: 1, max_value: 6, n: 3 },
      { b: "08:01", avg_value: 10, min_value: 10, max_value: 10, n: 1 },
    ]);
  });
});

describe("saklama ve sikistirma politikalari (D7)", () => {
  it("ham veri 3 gun, 1 dk agrega 30 gun, sikistirma 2 gun sonra", async () => {
    const r = await db.pool.query(
      "SELECT proc_name, hypertable_name, config FROM timescaledb_information.jobs WHERE proc_name IN ('policy_compression','policy_retention','policy_refresh_continuous_aggregate') ORDER BY proc_name, hypertable_name",
    );
    // Cagg politikalari goruntu adiyla degil, iç materyalizasyon hypertable'i (_materialized_hypertable_N) altinda kayitlidir.
    const mat = (await db.pool.query(
      "SELECT materialization_hypertable_name AS n FROM timescaledb_information.continuous_aggregates WHERE view_name='metric_1m'",
    )).rows[0].n as string;
    const by = (p: string, h: string) => r.rows.find((x) => x.proc_name === p && x.hypertable_name === h)?.config;
    // 0003 (M2 depolama olcumu): ham veri 12 saat sonra sikistirilir (siksitirmasiz pencere kisa), 1 dk agrega 3 gun sonra.
    expect(by("policy_compression", "metric_samples")?.compress_after).toBe("12:00:00");
    expect(by("policy_retention", "metric_samples")?.drop_after).toBe("3 days");
    expect(by("policy_retention", mat)?.drop_after).toBe("30 days");
    expect(by("policy_refresh_continuous_aggregate", mat)?.start_offset).toBe("2 days");
    expect(by("policy_compression", mat)?.compress_after).toBe("3 days"); // agrega yenileme penceresinden (2 gun) SONRA
  });

  it("chunk araligi 6 saat (kisa sikistirma penceresi icin), agrega sikistirma acik", async () => {
    const dim = (await db.pool.query(
      "SELECT time_interval FROM timescaledb_information.dimensions WHERE hypertable_name='metric_samples'")).rows[0];
    expect(dim.time_interval).toEqual({ hours: 6 });
    const cagg = (await db.pool.query(
      "SELECT compression_enabled FROM timescaledb_information.continuous_aggregates WHERE view_name='metric_1m'")).rows[0];
    expect(cagg.compression_enabled).toBe(true);
  });

  it("B0 spike: sikistirilmis chunk'a (a) yinelenen ve (b) YENI satir eklenebilir", async () => {
    const d = (await db.pool.query("INSERT INTO devices (org_id, name) VALUES ($1,'cmp') RETURNING id", [orgA])).rows[0].id;
    const old = new Date(Date.now() - 36 * 3600 * 1000);
    const t = (s: number) => new Date(old.getTime() + s * 1000).toISOString();
    for (let i = 0; i < 20; i++) await insertSample(t(i), orgA, d, "cpu.total", i);

    const chunks = await db.pool.query("SELECT show_chunks('metric_samples', older_than => now() - interval '1 day') AS c");
    expect(chunks.rows.length).toBeGreaterThan(0);
    // Arka plandaki sikistirma politikasi isi ayni chunk'i es zamanli sikistirabilir (if_not_compressed bu yarista bile "already compressed" atar): yut.
    for (const row of chunks.rows) {
      try { await db.pool.query("SELECT compress_chunk($1::regclass, if_not_compressed => true)", [row.c]); }
      catch (e) { if (!/already compressed/.test((e as Error).message)) throw e; }
    }
    const compressed = await db.pool.query("SELECT count(*)::int AS n FROM timescaledb_information.chunks WHERE hypertable_name='metric_samples' AND is_compressed");
    expect(compressed.rows[0].n).toBeGreaterThan(0);

    await insertSample(t(3), orgA, d, "cpu.total", 12345); // (a) ayni anahtar: sessizce atlanir
    await insertSample(t(100), orgA, d, "cpu.total", 7);   // (b) yeni satir: kabul edilir

    const r = await db.pool.query("SELECT count(*)::int AS n, max(value) AS mx FROM metric_samples WHERE device_id=$1 AND metric='cpu.total'", [d]);
    expect(r.rows[0]).toEqual({ n: 21, mx: 19 }); // 20 eski + 1 yeni; 12345 EKLENMEDI
  });
});

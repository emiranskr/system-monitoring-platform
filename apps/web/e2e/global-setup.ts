import { execSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { API_ORIGIN, API_PORT, DEVICES, E2E_PASSWORD, STATE_FILE, USERS, WEB_ORIGIN, WEB_PORT, authFile, type E2EState } from "./constants";
import { createTestDb } from "../../../packages/db/dist/testing.js";
import { hashPassword } from "../../api/dist/password.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const webDir = resolve(here, "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

async function waitHttp(url: string, ok: (status: number) => boolean, what: string, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  let last = "";
  while (Date.now() < end) {
    try { const r = await fetch(url); if (ok(r.status)) return; last = String(r.status); } catch (e) { last = String(e); }
    await sleep(300);
  }
  throw new Error(`Zaman asimi: ${what} (${url}) son durum: ${last}`);
}

/**
 * E2E altyapisi: (1) bagimliliklari derler, (2) GERCEK TimescaleDB'de gecici veritabani, (3) derlenmis API sureci,
 * (4) ilk owner'i setup ucuyla olusturur, (5) kullanicilar/cihazlar/gecmis veri, (6) cevrimici cihaz icin arka plan ingest,
 * (7) Vite. Dondurdugu fonksiyon hepsini kapatir ve gecici veritabanini siler.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  execSync('pnpm --filter "@sysmon/api..." build', { cwd: root, stdio: "inherit" });

  const db = await createTestDb();
  const procs: ChildProcess[] = [];
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  const teardown = async () => {
    if (keepAlive) clearInterval(keepAlive);
    for (const p of procs) { try { p.kill(); } catch { /* zaten kapali */ } }
    await sleep(500);
    await db.drop().catch(() => undefined);
  };

  try {
    // --- API (derlenmis) ---
    let setupToken = "";
    const api = spawn(process.execPath, [join(root, "apps/api/dist/server.js")], {
      env: {
        ...process.env, DATABASE_URL: db.url, CREDENTIAL_KEY: randomBytes(32).toString("base64"), PORT: String(API_PORT), HOST: "127.0.0.1",
        ALLOWED_ORIGINS: WEB_ORIGIN, LOG_LEVEL: "warn", SAMPLE_INTERVAL_SECONDS: "5",
        // M5: uyarilar. YALNIZ test: yerel http webhook alicisina izin + kisa degerlendirme/kuyruk araliklari.
        CHANNEL_KEY: randomBytes(32).toString("base64"), ALERT_ALLOW_PRIVATE_TARGETS: "1", ALERT_ALLOW_INSECURE_WEBHOOK: "1", ALERT_EVALUATE_MS: "1000", ALERT_NOTIFY_MS: "1000",
      },
      stdio: ["ignore", "inherit", "pipe"],
    });
    procs.push(api);
    api.stderr!.on("data", (c: Buffer) => {
      const m = /: (\S{40,})\s*$/m.exec(String(c));
      if (m) setupToken = m[1]!; else process.stderr.write(c);
    });
    await waitHttp(`${API_ORIGIN}/api/v1/me`, (s) => s === 401, "API");
    for (let i = 0; i < 40 && !setupToken; i++) await sleep(250);
    if (!setupToken) throw new Error("Ilk kurulum token'i API stderr'inde bulunamadi");

    // --- ilk owner (setup ucu) ---
    const setup = await fetch(`${API_ORIGIN}/api/v1/setup`, {
      method: "POST", headers: { "content-type": "application/json", origin: WEB_ORIGIN },
      body: JSON.stringify({ token: setupToken, email: USERS.owner, password: E2E_PASSWORD }),
    });
    if (setup.status !== 201) throw new Error(`setup basarisiz: ${setup.status} ${await setup.text()}`);

    const q = (sql: string, p: unknown[] = []) => db.pool.query(sql, p);
    const orgId = (await q("SELECT org_id FROM users WHERE email=$1", [USERS.owner])).rows[0].org_id as string;
    const orgBId = (await q("INSERT INTO orgs (name) VALUES ('org-b') RETURNING id")).rows[0].id as string;
    const hash = await hashPassword(E2E_PASSWORD);
    await q("INSERT INTO users (org_id, email, password_hash, role) VALUES ($1,$2,$3,'admin'), ($1,$4,$3,'viewer'), ($5,$6,$3,'owner'), ($1,$7,$3,'viewer')",
      [orgId, USERS.admin, hash, USERS.viewer, orgBId, USERS.orgB, USERS.revoke]);

    // --- cihazlar ---
    const info = (hostname: string) => JSON.stringify({ hostname, os: "Windows 11", agent_version: "0.1.0", gpus: [], adapters: [{ id: "eth0", name: "Ethernet" }], volumes: [{ id: "C", name: "C:" }] });
    const now = Date.now();
    const mk = async (org: string, name: string, lastSeenAgoMs: number | null, revoked = false) => {
      const id = (await q("INSERT INTO devices (org_id, name, last_seen_at, revoked_at, device_info) VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [org, name, lastSeenAgoMs === null ? null : new Date(now - lastSeenAgoMs), revoked ? new Date(now) : null, info(name)])).rows[0].id as string;
      const token = "e2e_" + randomBytes(24).toString("base64url");
      await q("INSERT INTO device_tokens (token_hash, org_id, device_id) VALUES ($1,$2,$3)", [createHash("sha256").update(token).digest(), org, id]);
      return { id, token };
    };
    const devices = {
      online: await mk(orgId, DEVICES.online, 1000),
      gap: await mk(orgId, DEVICES.gap, 5 * 3600_000),
      offline: await mk(orgId, DEVICES.offline, 6 * 3600_000),
      never: await mk(orgId, DEVICES.never, null),
      revoked: await mk(orgId, DEVICES.revoked, 7 * 3600_000, true),
      evil: await mk(orgId, DEVICES.evil, 8 * 3600_000),
      orgB: await mk(orgBId, DEVICES.orgB, 1000),
    } satisfies E2EState["devices"];

    // --- gecmis veri ---
    const minute = 60_000, hour = 3600_000;
    const T = new Date(Math.floor(now / minute) * minute);
    const seed = (dev: string, org: string, metrics: string[], from: Date, to: Date, stepSec: number, holeFrom?: Date, holeTo?: Date) =>
      q(`INSERT INTO metric_samples (ts, org_id, device_id, metric, value)
         SELECT t, $1, $2, m, 10 + (extract(epoch from t)::bigint % 60) + length(m) % 7
           FROM generate_series($3::timestamptz, $4::timestamptz, make_interval(secs => $5::float8)) t, unnest($6::text[]) m
          WHERE $7::timestamptz IS NULL OR NOT (t >= $7::timestamptz AND t < $8::timestamptz)`,
        [org, dev, from, to, stepSec, metrics, holeFrom ?? null, holeTo ?? null]);
    const GPU_ID = "gpu-46139694-b075-6c98-9b95-3b6f3a465823"; // NVML UUID tabanli CanonicalId (M4)
    const M = ["cpu.total", "mem.used_pct", "disk.c.used_pct", "net.eth0.rx_bps", "net.eth0.tx_bps",
      `gpu.${GPU_ID}.util_pct`, `gpu.${GPU_ID}.vram_used_bytes`, `gpu.${GPU_ID}.temp_c`];
    await seed(devices.online.id, orgId, M, new Date(T.getTime() - 3 * hour), new Date(now - 5000), 5);          // son 3 sa, 5 sn (ham)
    await seed(devices.online.id, orgId, M, new Date(T.getTime() - 26 * hour), new Date(T.getTime() - 3 * hour - minute), 60); // 1 dk katman gecmisi
    await seed(devices.gap.id, orgId, ["cpu.total", "mem.used_pct"], new Date(T.getTime() - 3 * hour), new Date(now - 5000), 5,
      new Date(T.getTime() - 50 * minute), new Date(T.getTime() - 30 * minute)); // 20 dk BOSLUK
    await seed(devices.orgB.id, orgBId, ["cpu.total"], new Date(T.getTime() - hour), new Date(now - 5000), 5);
    await q("CALL refresh_continuous_aggregate('metric_1m', $1::timestamptz, $2::timestamptz)", [new Date(T.getTime() - 27 * hour), new Date(T.getTime() - minute)]);

    // --- cevrimici cihaz icin arka plan ingest (last_seen + SSE akisi) ---
    const epoch = randomUUID();
    let seq = 0;
    const tick = async () => {
      const t = new Date();
      const m = { "cpu.total": 20 + Math.round(Math.random() * 40), "mem.used_pct": 55, "disk.c.used_pct": 61, "net.eth0.rx_bps": 2048, "net.eth0.tx_bps": 1024 };
      const body = gzipSync(Buffer.from(JSON.stringify({ v: 1, spool_epoch: epoch, seq: seq++, sent_at: iso(t), samples: [{ ts: iso(t), m }] })));
      await fetch(`${API_ORIGIN}/agent/v1/ingest`, { method: "POST", headers: { "content-type": "application/json", "content-encoding": "gzip", authorization: `Bearer ${devices.online.token}` }, body }).catch(() => undefined);
    };
    // Tohum (ham 5 sn katman) `now - 5 sn`de biter; yavas ortamlarda (CI) tohumlama/aggregate yenileme saniyelerce surer ve canli akis baslayana kadar
    // "duzenli seride bosluk yok" testini bozan GERCEK bir bosluk kalir. Canli akis baslamadan hemen once aradaki bosluk ayni 5 sn adimiyla doldurulur.
    await seed(devices.online.id, orgId, M, new Date(now), new Date(), 5);
    await tick();
    keepAlive = setInterval(() => void tick(), 4000);

    // --- Oturum durumlari (storageState): her rol icin BIR kez giris; testler tekrar giris yapmaz (giris hiz sinirina takilmaz) ---
    for (const [role, email] of [["owner", USERS.owner], ["admin", USERS.admin], ["viewer", USERS.viewer]] as const) {
      const r = await fetch(`${API_ORIGIN}/api/v1/login`, {
        method: "POST", headers: { "content-type": "application/json", origin: WEB_ORIGIN }, body: JSON.stringify({ email, password: E2E_PASSWORD }),
      });
      if (r.status !== 200) throw new Error(`${role} girisi basarisiz: ${r.status}`);
      const sid = /__Host-sid=([^;]+)/.exec(r.headers.get("set-cookie") ?? "")?.[1];
      if (!sid) throw new Error(`${role}: oturum cerezi alinamadi`);
      const file = authFile(role);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ cookies: [{ name: "__Host-sid", value: sid, domain: "localhost", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }], origins: [] }));
    }

    // --- Vite (ayni koken proxy) ---
    const viteBin = join(dirname(createRequire(join(webDir, "package.json")).resolve("vite/package.json")), "bin/vite.js");
    const vite = spawn(process.execPath, [viteBin, "--port", String(WEB_PORT), "--host", "localhost"], {
      cwd: webDir, env: { ...process.env, API_PORT: String(API_PORT), WEB_PORT: String(WEB_PORT) }, stdio: ["ignore", "inherit", "inherit"],
    });
    procs.push(vite);
    await waitHttp(`${WEB_ORIGIN}/`, (s) => s === 200, "Vite");

    const state: E2EState = { dbUrl: db.url, orgId, orgBId, devices };
    mkdirSync(dirname(fileURLToPath(STATE_FILE)), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    return teardown;
  } catch (e) {
    await teardown();
    throw e;
  }
}

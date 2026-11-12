import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { X509Certificate, createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@sysmon/db/testing";
import { buildApp } from "../src/app.js";
import { hashToken } from "../src/tokens.js";

/**
 * GERCEK HTTPS uca-uca: agent'in RELEASE derlemesi (yalnizca https kabul eder) gercek Fastify HTTPS sunucusuna ve gercek
 * TimescaleDB'ye baglanir. Sertifika dogrulamasi SPKI sabitlemesiyle yapilir. Dogru pin -> veri akar; YANLIS pin -> agent
 * TLS el sikismasinda reddeder, sunucu HICBIR istek gormez (dolayisiyla token da gonderilmez); duz HTTP baglantisi reddedilir.
 */
const exe = resolve(__dirname, "../../../agent/windows/src/Agent.Service/bin/Release/net10.0-windows/Agent.Service.exe");
const haveOpenssl = spawnSync("openssl", ["version"]).status === 0;
const enabled = process.platform === "win32" && existsSync(exe) && haveOpenssl;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond: () => Promise<boolean>, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await sleep(500); }
  throw new Error(`Zaman asimi: ${what}`);
};

function makeCert(dir: string, name: string) {
  const key = join(dir, `${name}.key`), crt = join(dir, `${name}.crt`);
  const r = spawnSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-keyout", key, "-out", crt, "-days", "1", "-subj", `/CN=sysmon-${name}`, "-addext", "subjectAltName=IP:127.0.0.1"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`openssl basarisiz: ${r.stderr}`);
  const pem = readFileSync(crt);
  const spki = new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" });
  return { key: readFileSync(key), cert: pem, pin: "sha256/" + createHash("sha256").update(spki).digest("base64") };
}

describe.skipIf(!enabled)("agent (Release) <-> API gercek HTTPS", () => {
  let db: TestDb, dir: string, app: FastifyInstance;
  let port = 0;
  let good: ReturnType<typeof makeCert>, other: ReturnType<typeof makeCert>;
  const seen: string[] = [];           // sunucunun gordugu her HTTP istegi (TLS basarisizsa hic olmaz)
  const procs: ChildProcess[] = [];
  const tokens = new Map<string, { device: string; token: string }>();

  async function device(label: string) {
    const org = (await db.pool.query("INSERT INTO orgs (name) VALUES ($1) RETURNING id", [label])).rows[0].id;
    const id = (await db.pool.query("INSERT INTO devices (org_id, name) VALUES ($1,$2) RETURNING id", [org, label])).rows[0].id;
    const token = `tok_${label}_` + "ab12cd34ef56".repeat(5);
    await db.pool.query("INSERT INTO device_tokens (token_hash, org_id, device_id) VALUES ($1,$2,$3)", [hashToken(token), org, id]);
    tokens.set(label, { device: id, token });
    return { id, token };
  }
  function importToken(label: string, token: string) {
    const data = mkdtempSync(join(dir, `${label}-`));
    const plain = join(data, "bootstrap.txt");
    writeFileSync(plain, token, "ascii");
    const r = spawnSync(exe, ["--import-token", plain, "--data-dir", data], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`token import basarisiz: ${r.stdout}${r.stderr}`);
    return data;
  }
  const startAgent = (data: string, pin: string) => {
    const p = spawn(exe, ["--server", `https://127.0.0.1:${port}`, "--server-pin", pin, "--data-dir", data], { stdio: "ignore" });
    procs.push(p);
    return p;
  };
  const rowCount = async (deviceId: string) =>
    Number((await db.pool.query("SELECT count(*) FROM metric_samples WHERE device_id=$1", [deviceId])).rows[0].count);

  beforeAll(async () => {
    db = await createTestDb();
    dir = mkdtempSync(join(tmpdir(), "sysmon-tls-"));
    good = makeCert(dir, "good");
    other = makeCert(dir, "other");
    const probe = buildApp({ pool: db.pool, credentialKey: Buffer.alloc(32, 1) });
    await probe.listen({ port: 0, host: "127.0.0.1" });
    port = (probe.server.address() as { port: number }).port;
    await probe.close();

    app = buildApp({ pool: db.pool, credentialKey: Buffer.alloc(32, 1), sampleIntervalSeconds: 1, https: { key: good.key, cert: good.cert } });
    app.addHook("onRequest", async (req) => { seen.push(`${req.method} ${req.url}`); });
    await app.listen({ port, host: "127.0.0.1" });
  }, 120_000);

  afterAll(async () => {
    for (const p of procs) p.kill();
    await sleep(500);
    await app?.close().catch(() => undefined);
    await db?.drop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("DOGRU pin: agent TLS'i dogrular, veri HTTPS uzerinden gelir", async () => {
    const d = await device("dogru");
    const data = importToken("dogru", d.token);
    startAgent(data, good.pin);
    await waitFor(async () => (await rowCount(d.id)) >= 5, 60_000, "HTTPS uzerinden veri gelmedi");
    expect(seen.some((s) => s.startsWith("POST /agent/v1/ingest"))).toBe(true);
  }, 120_000);

  it("YANLIS pin (sertifika dogrulanamaz): agent reddeder, sunucu HICBIR istek gormez, veri yazilmaz", async () => {
    const d = await device("yanlis");
    const data = importToken("yanlis", d.token);
    startAgent(data, other.pin); // sunucu 'good' sertifikasini sunar, agent 'other' pin'ini bekler
    const logPath = join(data, "logs", "agent.log");
    await waitFor(async () => existsSync(logPath) && readFileSync(logPath, "utf8").includes("sertifikasi dogrulanamadi"), 60_000,
      "agent TLS reddi gunlugu gorulmedi");

    // Reddedilen agent'in istegi sunucuya hic ulasmadi (el sikismasi basarisiz): bu cihazin token'i HIC kullanilmadi.
    // Sunucu bir istek gorseydi kimlik dogrulama last_seen_at'i ve ingest satirlari yazardi; ikisi de bos kalmalidir.
    expect(await rowCount(d.id)).toBe(0);
    const lastSeen = (await db.pool.query("SELECT last_seen_at FROM devices WHERE id=$1", [d.id])).rows[0].last_seen_at;
    expect(lastSeen).toBeNull();
    const used = (await db.pool.query("SELECT first_used_at FROM device_tokens WHERE device_id=$1", [d.id])).rows[0].first_used_at;
    expect(used).toBeNull(); // token sunucuda hic sunulmadi
  }, 120_000);

  it("duz HTTP baglantisi HTTPS portunda reddedilir (sunucuya HTTP istegi olarak ulasmaz)", async () => {
    const before = seen.length;
    const outcome = await new Promise<string>((resolveP) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/agent/v1/ingest", method: "POST", timeout: 5000 }, (res) => {
        res.resume();
        resolveP(`yanit:${res.statusCode}`);
      });
      req.on("error", () => resolveP("hata"));
      req.on("timeout", () => { req.destroy(); resolveP("hata"); });
      req.end("{}");
    });
    expect(outcome).toBe("hata");
    await sleep(500);
    expect(seen.slice(before).filter((s) => s.startsWith("POST") && !s.includes("/agent/v1/ingest"))).toEqual([]);
  });

  it("agent RELEASE http:// sunucuyu REDDEDER (sureci baslatmaz, sifirdan farkli cikis)", () => {
    const data = mkdtempSync(join(dir, "httpred-"));
    const r = spawnSync(exe, ["--server", "http://127.0.0.1:9", "--data-dir", data], { encoding: "utf8", timeout: 20_000 });
    expect(r.status).not.toBe(0);
    expect(r.status).not.toBeNull();
  });
});

import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";

/**
 * Sahte agent (B5): gercek Windows agent'inin PROTOKOL davranisini taklit eder (stop-and-wait, onaylanana kadar silmeme,
 * gecici/kalici hata siniflari, ayni batch icin 10 kalici 4xx sonrasi atma, 409'da server_time ile saat ofseti). Kesinti,
 * replay, zehirli batch, epoch sifirlama ve toplu yeniden baglanma senaryolari icin yuk ve entegrasyon testlerinde kullanilir.
 */
export type DrainResult = "empty" | "auth_failed" | "retry_later";

export interface FakeAgentOptions {
  baseUrl: string;
  token: string;
  /** Bir batch'teki ornek sayisi (varsayilan 5) ve ornek basina metrik (varsayilan 30). */
  samplesPerBatch?: number;
  metricsPerSample?: number;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  epoch?: string;
}

interface Pending { epoch: string; seq: number; samples: { ts: string; m: Record<string, number | null> }[]; raw?: Buffer; permanent4xx: number }

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

export class FakeAgent {
  epoch: string;
  nextSeq = 0;
  readonly queue: Pending[] = [];
  acked = 0;
  dropped = 0;
  /** Sunucudan ogrenilen saat ofseti (ms). */
  clockOffsetMs = 0;
  /** Sunucunun bildirdigi ornekleme araligi (sn). */
  serverIntervalSeconds: number | undefined;
  readonly statuses = new Map<number | "hata", number>();
  lastAckedBody: Pending | undefined;

  constructor(private o: FakeAgentOptions) {
    this.epoch = o.epoch ?? randomUUID();
    this.cursor = (o.now?.() ?? new Date()).getTime() - 10 * 60_000; // alan baslaticilari parametre ozelliklerinden ONCE calisir
  }

  private now(): Date { return this.o.now?.() ?? new Date(); }

  /** Ornek zaman imleci: gercek agent gibi her ornek BIR onceki orneginden 1 sn sonradir (ayni (cihaz, metrik, ts) sunucuda yinelenen sayilir). */
  private cursor: number;

  /** n batch uretir ve kuyrugun SONUNA ekler (spool'a yazma). Ornek zamanlari uretim aninda sabitlenir, batch'ler boyunca ilerler. */
  enqueue(n = 1): void {
    const spb = this.o.samplesPerBatch ?? 5, mps = this.o.metricsPerSample ?? 30;
    for (let b = 0; b < n; b++) {
      const samples = Array.from({ length: spb }, (_, i) => ({
        ts: iso(new Date((this.cursor += 1000))),
        m: Object.fromEntries(Array.from({ length: mps }, (_, j) => [`fake.m${String(j).padStart(2, "0")}`, (j * 7 + i + b) % 100])),
      }));
      this.queue.push({ epoch: this.epoch, seq: this.nextSeq++, samples, permanent4xx: 0 });
    }
  }

  /** Gecersiz sema (kalici 400) uretecek ZEHIRLI batch ekler: agent ayni batch'i 10 kez dener, sonra atar. */
  enqueuePoison(): void {
    this.queue.push({ epoch: this.epoch, seq: this.nextSeq++, samples: [], raw: Buffer.from('{"v":1,"bozuk":true}'), permanent4xx: 0 });
  }

  /** Spool kaybi/yeniden kurulum: yeni epoch, seq 0'dan baslar; eski epoch'lu bekleyen batch'ler kendi epoch'lariyla gider. */
  resetEpoch(): void {
    this.epoch = randomUUID();
    this.nextSeq = 0;
  }

  private async send(p: Pending): Promise<{ status: number | "hata"; json?: any }> {
    const body = p.raw ?? Buffer.from(JSON.stringify({
      v: 1, spool_epoch: p.epoch, seq: p.seq, sent_at: iso(new Date(this.now().getTime() + this.clockOffsetMs)), samples: p.samples,
    }));
    try {
      const r = await (this.o.fetchImpl ?? fetch)(`${this.o.baseUrl}/agent/v1/ingest`, {
        method: "POST", body: gzipSync(body),
        headers: { "content-type": "application/json", "content-encoding": "gzip", authorization: `Bearer ${this.o.token}` },
      });
      let json: any;
      try { json = await r.json(); } catch { json = undefined; }
      return { status: r.status, json };
    } catch {
      return { status: "hata" };
    }
  }

  private count(s: number | "hata") { this.statuses.set(s, (this.statuses.get(s) ?? 0) + 1); }

  /**
   * Stop-and-wait bosaltma: en eski batch gonderilir; yalniz GECERLI onayda (ack_seq >= seq) silinir. Donus:
   *  - "empty": kuyruk bosaldi; "auth_failed": 401/403 (kuyruk korunur); "retry_later": gecici hata/429/5xx/ag (kuyruk korunur).
   * 409: server_time'dan ofset ogrenir ve ayni batch'i HEMEN yeniden dener. Kalici 4xx: ayni batch icin 10 ardisik -> atilir.
   */
  async drain(maxSteps = Infinity): Promise<DrainResult> {
    for (let step = 0; step < maxSteps; step++) {
      const p = this.queue[0];
      if (!p) return "empty";
      const { status, json } = await this.send(p);
      this.count(status);
      if (status === 200 && json && Number.isInteger(json.ack_seq) && json.ack_seq >= p.seq) {
        this.queue.shift();
        this.acked++;
        this.lastAckedBody = p;
        if (Number.isInteger(json.config?.interval_seconds)) this.serverIntervalSeconds = json.config.interval_seconds;
        continue;
      }
      if (status === 401 || status === 403) return "auth_failed";
      if (status === 409 && json?.server_time) {
        this.clockOffsetMs = new Date(json.server_time).getTime() - this.now().getTime();
        continue;
      }
      if (typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429) {
        if (++p.permanent4xx >= 10) { this.queue.shift(); this.dropped++; continue; }
        continue; // ayni batch yeniden denenir (gercek agent backoff'la; burada yaris/yuk icin hemen)
      }
      return "retry_later";
    }
    return "retry_later";
  }

  /** Daha once ONAYLANMIS son batch'i AYNEN yeniden gonderir (replay): sunucu idempotent olmali. */
  async replayLastAcked(): Promise<number | "hata"> {
    if (!this.lastAckedBody) throw new Error("onaylanmis batch yok");
    const r = await this.send(this.lastAckedBody);
    this.count(r.status);
    return r.status;
  }
}

export interface FleetOptions extends Omit<FakeAgentOptions, "token"> {
  devices: { token: string }[];
}

/** N sahte agent (filo). */
export function makeFleet(o: FleetOptions): FakeAgent[] {
  return o.devices.map((d) => new FakeAgent({ ...o, token: d.token }));
}

import { HttpError } from "./errors.js";

export const MAX_LIMITER_KEYS = 100_000;

/**
 * IP sinir anahtari: IPv4 aynen; IPv4-eslemeli IPv6 IPv4'e iner; IPv6 /64 oneki (bir istemci tum /64'unu kontrol eder,
 * tek adresle sinirlamak kolayca asilirdi ve anahtar tablosunu sisirirdi).
 */
export function ipKey(ip: string): string {
  const addr = ip.split("%")[0]!.toLowerCase();
  const mapped = /^(?:0*:)*ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (mapped) return mapped[1]!;
  if (!addr.includes(":") || addr.includes(".")) return addr;
  const [head = "", tail] = addr.split("::") as [string, string?];
  const h = head === "" ? [] : head.split(":");
  const t = tail === undefined || tail === "" ? [] : tail.split(":");
  const groups = tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

/**
 * Sabit pencereli, bellek ici sayac. Saat enjekte edilir (test). Bellek SINIRLI: anahtar sayisi `maxKeys`'i asmaz;
 * dolunca pencere basina en fazla BIR temizleme yapilir (her istekte O(n) tarama yok), hala doluysa yeni anahtarlar
 * SAYILMAZ (fail-open: bellek korunur, mesru yeni istemci engellenmez; mevcut anahtarlar sinirlanmaya devam eder).
 */
export class RateLimiter {
  private entries = new Map<string, { win: number; n: number }>();
  private lastPruneWin = -1;
  pruneCount = 0;

  constructor(private max: number, private windowMs: number, private now: () => Date, private maxKeys = MAX_LIMITER_KEYS) {}

  get size(): number { return this.entries.size; }

  private win(): number { return Math.floor(this.now().getTime() / this.windowMs); }

  /** Sayaci artirir; sinir ASILDIYSA false doner. */
  hit(key: string): boolean {
    const w = this.win();
    let e = this.entries.get(key);
    if (!e && this.entries.size >= this.maxKeys) {
      if (this.lastPruneWin !== w) { this.lastPruneWin = w; this.pruneCount++; this.prune(w); }
      if (this.entries.size >= this.maxKeys) return true; // tablo dolu: yeni anahtar izlenmez
    }
    e = this.entries.get(key);
    if (!e || e.win !== w) { this.entries.set(key, { win: w, n: 1 }); return this.max >= 1; }
    e.n++;
    return e.n <= this.max;
  }

  /** Sayaci ARTIRMADAN, anahtar su an sinirda mi? */
  isLimited(key: string): boolean {
    const e = this.entries.get(key);
    return !!e && e.win === this.win() && e.n >= this.max;
  }

  /** Pencerenin bitmesine kalan saniye (Retry-After). */
  retryAfterSeconds(): number {
    return Math.max(1, Math.ceil(((this.win() + 1) * this.windowMs - this.now().getTime()) / 1000));
  }

  private prune(current: number): void {
    for (const [k, e] of this.entries) if (e.win !== current) this.entries.delete(k);
  }
}

export interface Limits {
  /** Cihaz basina ingest istegi / pencere (agent normalde dakikada ~12; spool bosalmasi icin pay). */
  ingestPerDevice?: number;
  /** IP basina BASARISIZ kimlik dogrulama / pencere: asildiginda o IP'den gecerli token bile reddedilir (kaba kuvvet). */
  failedAuthPerIp?: number;
  /** IP basina enrollment denemesi / pencere (token tahmini). */
  enrollPerIp?: number;
  /** Cihaz basina rotation istegi / pencere. */
  rotatePerDevice?: number;
  windowMs?: number;
}

export interface Limiters {
  ingestPerDevice: RateLimiter;
  failedAuthPerIp: RateLimiter;
  enrollPerIp: RateLimiter;
  rotatePerDevice: RateLimiter;
}

export function createLimiters(l: Limits | undefined, now: () => Date): Limiters {
  const w = l?.windowMs ?? 60_000;
  return {
    ingestPerDevice: new RateLimiter(l?.ingestPerDevice ?? 300, w, now),
    failedAuthPerIp: new RateLimiter(l?.failedAuthPerIp ?? 30, w, now),
    // 60/dk: NAT arkasinda toplu kurulum (ayni ofisten cok makine) engellenmesin; token 256 bit oldugundan tahmin zaten imkansiz,
    // sinir asil olarak yuk ve rastgele denemeleri yavaslatmak icindir.
    enrollPerIp: new RateLimiter(l?.enrollPerIp ?? 60, w, now),
    rotatePerDevice: new RateLimiter(l?.rotatePerDevice ?? 10, w, now),
  };
}

export const rateLimited = (limiter: RateLimiter) =>
  new HttpError(429, "rate_limited", {}, { "retry-after": String(limiter.retryAfterSeconds()) });

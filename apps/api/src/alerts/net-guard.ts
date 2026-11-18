import dns from "node:dns";
import net from "node:net";

/**
 * SSRF korumasi: webhook ve SMTP hedefleri bu modulle cozumlenir. Cozumleme VE dogrulama tek adimdir: donen adres, baglantida
 * AYNEN kullanilir (DNS rebinding: ikinci bir cozumleme yok). Engellenenler: loopback, ozel (RFC1918), link-local (bulut meta veri
 * 169.254.169.254 dahil), CGNAT, belgelendirme/test, coklu yayin, rezerve ve IPv6 karsiliklari (IPv4-mapped, NAT64, 6to4 dahil).
 * Bir ad birden cok adrese cozumlenirse HERHANGI biri engelliyse TUMU reddedilir.
 */
export class SsrfError extends Error {
  constructor(message: string) { super(message); }
}

// [baslangic (32 bit), prefix]
const V4: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

function v4ToInt(ip: string): number | null {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  let n = 0;
  for (const s of p) {
    if (!/^\d{1,3}$/.test(s)) return null;
    const v = Number(s);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function blockedV4(n: number): boolean {
  for (const [base, bits] of V4) {
    const b = v4ToInt(base)!;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if (((n & mask) >>> 0) === ((b & mask) >>> 0)) return true;
  }
  return false;
}

/** IPv6 metnini 16 bayta cevirir (:: kisaltmasi ve gomulu noktali IPv4 desteklenir). Gecersizse null. */
function parseV6(ip: string): Uint8Array | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (!net.isIPv6(s)) return null;
  // gomulu IPv4 (::ffff:1.2.3.4)
  const last = s.lastIndexOf(":");
  const tail = s.slice(last + 1);
  if (tail.includes(".")) {
    const n = v4ToInt(tail);
    if (n === null) return null;
    s = `${s.slice(0, last + 1)}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const dbl = s.split("::");
  if (dbl.length > 2) return null;
  const head = dbl[0] ? dbl[0].split(":") : [];
  const rest = dbl.length === 2 && dbl[1] ? dbl[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (dbl.length === 2 ? missing < 0 : missing !== 0) return null;
  const groups = [...head, ...Array(dbl.length === 2 ? missing : 0).fill("0"), ...rest];
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[i]!)) return null;
    const v = parseInt(groups[i]!, 16);
    out[i * 2] = v >> 8;
    out[i * 2 + 1] = v & 0xff;
  }
  return out;
}

function prefixMatch(b: Uint8Array, base: number[], bits: number): boolean {
  for (let i = 0; i < bits; i++) {
    const bi = i >> 3, sh = 7 - (i & 7);
    if (((b[bi]! >> sh) & 1) !== ((base[bi]! >> sh) & 1)) return false;
  }
  return true;
}

const V6: [string, number][] = [
  ["::", 128], ["::1", 128], ["100::", 64], ["2001::", 32], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
];

function blockedV6(b: Uint8Array): boolean {
  const zeros10 = b.subarray(0, 10).every((x) => x === 0);
  if (zeros10 && b[10] === 0xff && b[11] === 0xff) return isBlockedV4Bytes(b.subarray(12));      // IPv4-mapped
  // NAT64 64:ff9b::/96: gomulu IPv4 denetlenir
  const nat64 = parseV6("64:ff9b::")!;
  if (prefixMatch(b, Array.from(nat64), 96)) return isBlockedV4Bytes(b.subarray(12));
  for (const [base, bits] of V6) if (prefixMatch(b, Array.from(parseV6(base)!), bits)) return true;
  return false;
}

function isBlockedV4Bytes(b: Uint8Array): boolean {
  return blockedV4((((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0));
}

/** true = engellenmeli. Gecersiz/ayristirilamayan metin guvenli tarafta ENGELLENIR. */
export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) { const n = v4ToInt(ip); return n === null ? true : blockedV4(n); }
  const b = parseV6(ip);
  return b === null ? true : blockedV6(b);
}

export interface Resolved { address: string; family: 4 | 6 }
export type LookupAll = (host: string) => Promise<{ address: string; family: number }[]>;

const defaultLookup: LookupAll = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

export async function resolveSafe(host: string, opts: { allowPrivate: boolean; lookup?: LookupAll }): Promise<Resolved> {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (net.isIP(bare)) {
    if (!opts.allowPrivate && isBlockedIp(bare)) throw new SsrfError("hedef adres engelli (ozel/loopback/link-local/rezerve)");
    return { address: bare, family: net.isIPv4(bare) ? 4 : 6 };
  }
  let addrs: { address: string; family: number }[];
  try { addrs = await (opts.lookup ?? defaultLookup)(bare); }
  catch { throw new SsrfError("hedef ad cozumlenemedi"); }
  if (addrs.length === 0) throw new SsrfError("hedef ad cozumlenemedi");
  if (!opts.allowPrivate && addrs.some((a) => isBlockedIp(a.address))) throw new SsrfError("hedef adres engelli (ozel/loopback/link-local/rezerve)");
  const first = addrs[0]!;
  return { address: first.address, family: net.isIPv4(first.address) ? 4 : 6 };
}

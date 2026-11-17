export type Unit = "pct" | "bytes_per_sec" | "bytes" | "celsius" | "watt" | "mhz";

/**
 * Agent `net.<anahtar>.rx_bps|tx_bps` metriklerini BAYT/SN olarak gonderir (Collectors.cs: fark baytlar / saniye) — metrik adindaki
 * "bps" yaniltici (bit degil). Gosterim 1024 tabanli: B/s, KB/s, MB/s, GB/s. (Adlandirma duzeltmesi ajan/protokol degisikligidir,
 * kapsam disi; docs/ilerleme/M3b.md'de takip notu.)
 */
export function formatBytesPerSec(v: number): string {
  if (Number.isNaN(v)) return "—";
  if (v < 1024) return `${Math.max(0, Math.round(v))} B/s`;
  const units = ["KB/s", "MB/s", "GB/s"];
  let x = v / 1024, i = 0;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return `${x.toFixed(1)} ${units[i]}`;
}

/** Bayt miktari (1024 tabanli): B, KB, MB, GB, TB. */
export function formatBytes(v: number): string {
  if (Number.isNaN(v)) return "—";
  if (v < 1024) return `${Math.max(0, Math.round(v))} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let x = v / 1024, i = 0;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return `${x.toFixed(1)} ${units[i]}`;
}

export function formatValue(unit: Unit, v: number): string {
  switch (unit) {
    case "pct": return `%${Math.round(v)}`;
    case "bytes_per_sec": return formatBytesPerSec(v);
    case "bytes": return formatBytes(v);
    case "celsius": return `${Math.round(v)} °C`;
    case "watt": return `${v.toFixed(1)} W`;
    case "mhz": return `${Math.round(v)} MHz`;
  }
}

/** HH:MM:SS (24 sa). timeZone testlerde sabitlenir; uygulamada tarayici dilimi. */
export function formatClock(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, ...(timeZone ? { timeZone } : {}) }).format(ms);
}

import type { DeviceStatus, DeviceSummary } from "@sysmon/protocol";

export const STATUS_LABEL: Record<DeviceStatus, string> = {
  online: "Çevrimiçi", stale: "Bayat", offline: "Çevrimdışı", unknown: "Bilinmiyor", revoked: "İptal edildi",
};
export const STATUS_ORDER: DeviceStatus[] = ["online", "stale", "offline", "unknown", "revoked"];

/**
 * Arama katlamasi: buyuk/kucuk harf duyarsiz VE Turkce i/I/ı/İ eslenik. `toLocaleLowerCase("tr")` "ISIK"i "ısık" yapar ve
 * "isik" aramasi eslesmezdi; cihaz adlari (ana bilgisayar adlari) cogunlukla ASCII oldugundan dort harfi de "i" sayariz.
 */
export function foldSearch(s: string): string {
  return s.replace(/[İIı]/g, "i").toLowerCase().replace(/̇/g, "");
}

/** Yuzde gosterimi: NULL (olcum yok) -> em tire; sifir DEGIL. */
export function formatPct(v: number | null): string {
  return v === null ? "—" : `%${Math.round(v)}`;
}

/** "5 sn önce" biciminde goreli zaman; gelecek tarih (saat sapmasi) ve < 1 sn "simdi". */
export function formatRelative(iso: string | null, now: Date): string {
  if (iso === null) return "hiç görülmedi";
  const diff = now.getTime() - new Date(iso).getTime();
  if (diff < 1000) return "şimdi";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s} sn önce`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} dk önce`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} sa önce`;
  return `${Math.floor(h / 24)} gün önce`;
}

export interface FleetSummary {
  total: number;
  counts: Record<DeviceStatus, number>;
  topCpu: DeviceSummary[];
  topMem: DeviceSummary[];
  topDisk: DeviceSummary[];
}

const TOP_N = 5;

function top(devs: DeviceSummary[], key: "cpu_pct" | "mem_pct" | "disk_used_pct"): DeviceSummary[] {
  return devs
    .filter((d) => d.status !== "revoked" && d[key] !== null)
    .sort((a, b) => (b[key]! - a[key]!) || a.name.localeCompare(b.name))
    .slice(0, TOP_N);
}

/** Saf fonksiyon: filo ozeti (durum sayilari + en yuksek kullanimlar). NULL ve iptal edilmis cihazlar siralamaya girmez. */
export function deriveFleetSummary(devices: DeviceSummary[]): FleetSummary {
  const counts: Record<DeviceStatus, number> = { online: 0, stale: 0, offline: 0, unknown: 0, revoked: 0 };
  for (const d of devices) counts[d.status]++;
  return { total: devices.length, counts, topCpu: top(devices, "cpu_pct"), topMem: top(devices, "mem_pct"), topDisk: top(devices, "disk_used_pct") };
}

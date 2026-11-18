import type { AlertRule } from "@sysmon/protocol";

/** Kural formunda sunulan metrikler (izin listesi alt kumesi; sunucu ayrica dogrular). Joker (*) = ilgili tum seriler (herhangi biri). */
export const METRIC_PRESETS: { value: string; label: string; unit: string }[] = [
  { value: "cpu.total", label: "CPU kullanımı", unit: "%" },
  { value: "mem.used_pct", label: "Bellek kullanımı", unit: "%" },
  { value: "disk.*.used_pct", label: "Disk doluluğu (herhangi bir disk)", unit: "%" },
  { value: "gpu.*.util_pct", label: "GPU kullanımı (herhangi bir GPU)", unit: "%" },
  { value: "gpu.*.temp_c", label: "GPU sıcaklığı (herhangi bir GPU)", unit: "°C" },
  { value: "gpu.*.vram_used_bytes", label: "GPU VRAM kullanımı (bayt)", unit: "bayt" },
  { value: "net.*.rx_bps", label: "Ağ alınan (bayt/sn)", unit: "bayt/sn" },
  { value: "net.*.tx_bps", label: "Ağ gönderilen (bayt/sn)", unit: "bayt/sn" },
  { value: "sensor.cpu_package_temp_c", label: "CPU paket sıcaklığı (sensör)", unit: "°C" },
  { value: "device.offline", label: "Cihaz çevrimdışı süresi", unit: "sn" },
];

export const SEVERITY_LABEL = { info: "Bilgi", warning: "Uyarı", critical: "Kritik" } as const;

export function metricLabel(metric: string): string {
  return METRIC_PRESETS.find((m) => m.value === metric)?.label ?? metric;
}

export function metricUnit(metric: string): string {
  return METRIC_PRESETS.find((m) => m.value === metric)?.unit ?? "";
}

const AGG_LABEL = { avg: "ort.", max: "maks." } as const;

/** Kural ozeti (kullaniciya): "CPU kullanımı ort. (60 sn) > 90 % — 120 sn boyunca". */
export function describeRule(r: Pick<AlertRule, "metric" | "agg" | "window_seconds" | "operator" | "threshold" | "for_seconds">): string {
  const unit = metricUnit(r.metric);
  const win = r.metric === "device.offline" ? "" : ` ${AGG_LABEL[r.agg]} (${r.window_seconds} sn)`;
  const dur = r.for_seconds > 0 ? ` — ${r.for_seconds} sn boyunca` : "";
  return `${metricLabel(r.metric)}${win} ${r.operator} ${r.threshold}${unit ? ` ${unit}` : ""}${dur}`;
}

export function formatValue(v: number | null): string {
  if (v === null) return "—";
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** Webhook/SMTP olusturma hatalari -> aciklayici Turkce metin (sir veya hedef ayrintisi sizdirilmaz). */
export function channelErrorText(status: number, code: string): string {
  if (code === "blocked_target") return "Hedef adres güvenlik nedeniyle reddedildi (özel/yerel ağ adresleri kullanılamaz).";
  if (code === "secrets_unavailable") return "Sunucuda kanal sır anahtarı (CHANNEL_KEY) yapılandırılmamış; kanal oluşturulamıyor.";
  if (code === "too_many_channels") return "Kanal sayısı sınırına ulaşıldı.";
  if (status === 400) return "Girdiler geçersiz. Adres https:// ile başlamalı ve alanlar doğru olmalı.";
  if (status === 403) return "Bu işlem için yetkiniz yok.";
  if (status === 429) return "Çok fazla istek. Biraz bekleyin.";
  return "İşlem tamamlanamadı. Yeniden deneyin.";
}

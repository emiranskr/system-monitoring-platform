/**
 * Uyari kuralinin izinli degerleri: SABIT izin listesi. Kullanicidan gelen metrik adi/operator/agg HICBIR zaman SQL metnine eklenmez
 * (sorgularda yalniz parametre); bu liste ayrica kural olusturma ve degerlendirme sirasinda ikinci kez uygulanir.
 */
export const OPERATORS = [">", ">=", "<", "<="] as const;
export const AGGS = ["avg", "max"] as const;
export const SEVERITIES = ["info", "warning", "critical"] as const;
export const BUILTINS = ["offline", "disk_full", "cpu_high", "mem_high"] as const;

/** Ozel metrik: cihazin sunucuya son ulasma zamanindan beri gecen saniye (ornek `ts` DEGIL, sunucu alim zamani). */
export const OFFLINE_METRIC = "device.offline";

const SEG = "[A-Za-z0-9_\\-:]";
const METRIC_PATTERNS: RegExp[] = [
  /^cpu\.total$/,
  /^mem\.used_pct$/,
  new RegExp(`^disk\\.(\\*|${SEG}{1,30})\\.used_pct$`),
  new RegExp(`^net\\.(\\*|${SEG}{1,40})\\.(rx_bps|tx_bps)$`),
  new RegExp(`^gpu\\.(\\*|[A-Za-z0-9\\-:]{1,44})\\.(util_pct|temp_c|vram_used_bytes|power_w|fan_pct|core_clock_mhz|mem_clock_mhz)$`),
  /^sensor\.(cpu_package_temp_c|cpu_core_max_temp_c|motherboard_temp_c|cpu_fan_rpm)$/,
  /^device\.offline$/,
];

export function isAllowedMetric(m: unknown): m is string {
  return typeof m === "string" && m.length <= 64 && METRIC_PATTERNS.some((re) => re.test(m));
}

/** `*` iceren metrik (orn. disk.*.used_pct) icin LIKE kalibi; `%`, `_`, `\` kacirilir. Joker yoksa null. */
export function metricLikePattern(m: string): string | null {
  if (!m.includes("*")) return null;
  return m.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/\*/g, "%");
}

export interface BuiltinDef {
  builtin: (typeof BUILTINS)[number];
  name: string;
  metric: string;
  agg: "avg" | "max";
  window_seconds: number;
  operator: ">" ;
  threshold: number;
  hysteresis: number;
  for_seconds: number;
  severity: "info" | "warning" | "critical";
}

/**
 * Yerlesik kurallar. Cevrimdisi: esik 60 sn + for 300 sn (agent geri cekilme tavani) = ~6 dk grace (N6).
 * Disk dolu / yuksek CPU / yuksek RAM. Sicaklik ve GPU icin yerlesik kural YOK (kullanici tanimli kural).
 */
export const BUILTIN_RULES: BuiltinDef[] = [
  { builtin: "offline", name: "Cihaz çevrimdışı", metric: OFFLINE_METRIC, agg: "max", window_seconds: 60, operator: ">", threshold: 60, hysteresis: 0, for_seconds: 300, severity: "critical" },
  { builtin: "disk_full", name: "Disk dolu", metric: "disk.*.used_pct", agg: "max", window_seconds: 300, operator: ">", threshold: 90, hysteresis: 2, for_seconds: 300, severity: "warning" },
  { builtin: "cpu_high", name: "Sürekli yüksek CPU", metric: "cpu.total", agg: "avg", window_seconds: 300, operator: ">", threshold: 90, hysteresis: 5, for_seconds: 300, severity: "warning" },
  { builtin: "mem_high", name: "Sürekli yüksek bellek", metric: "mem.used_pct", agg: "avg", window_seconds: 300, operator: ">", threshold: 90, hysteresis: 5, for_seconds: 300, severity: "warning" },
];

/** Cevrimdisi alarm grace suresi: sunucu acilisindan/ingest sagliksizligindan sonra bu sure boyunca cevrimdisi alarmi uretilmez. */
export const OFFLINE_GRACE_MS = 6 * 60_000;

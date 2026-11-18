import { ALERT_AGGS, ALERT_BUILTINS, ALERT_OPERATORS, ALERT_SEVERITIES, OFFLINE_METRIC, isAllowedAlertMetric } from "@sysmon/protocol";

/**
 * Uyari kuralinin izinli degerleri: SABIT izin listesi, TEK kaynak packages/protocol/src/alerts.ts. Kullanicidan gelen metrik
 * adi/operator/agg HICBIR zaman SQL metnine eklenmez (sorgularda yalniz parametre); liste kural olusturmada ve degerlendirmede uygulanir.
 */
export const OPERATORS = ALERT_OPERATORS;
export const AGGS = ALERT_AGGS;
export const SEVERITIES = ALERT_SEVERITIES;
export const BUILTINS = ALERT_BUILTINS;
export { OFFLINE_METRIC };
export const isAllowedMetric = isAllowedAlertMetric;

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

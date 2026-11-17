export type RangeId = "1h" | "6h" | "24h" | "7d" | "30d";

export const RANGES: { id: RangeId; label: string; seconds: number }[] = [
  { id: "1h", label: "1 sa", seconds: 3600 },
  { id: "6h", label: "6 sa", seconds: 6 * 3600 },
  { id: "24h", label: "24 sa", seconds: 86400 },
  { id: "7d", label: "7 gün", seconds: 7 * 86400 },
  { id: "30d", label: "30 gün", seconds: 30 * 86400 },
];

/** Secilen aralik -> API penceresi (UTC ISO). 30 gun, API'nin 31 gun sinirinin icindedir. */
export function rangeToWindow(range: RangeId, now: Date): { from: string; to: string } {
  const r = RANGES.find((x) => x.id === range)!;
  return { from: new Date(now.getTime() - r.seconds * 1000).toISOString(), to: now.toISOString() };
}

/** Yakinlastir = bir kisa on ayar, uzaklastir = bir uzun; uclarda sabit (fircaya KLAVYE ALTERNATIFI). */
export function zoomRange(range: RangeId, dir: "in" | "out"): RangeId {
  const i = RANGES.findIndex((r) => r.id === range);
  const j = Math.min(RANGES.length - 1, Math.max(0, i + (dir === "in" ? -1 : 1)));
  return RANGES[j]!.id;
}

/** `max_points`: grafik piksel genisligi, API'nin 10..1500 araligina sikistirilir; bilinmiyorsa 600. */
export function maxPointsForWidth(px: number): number {
  if (!Number.isFinite(px) || px <= 0) return 600;
  return Math.min(1500, Math.max(10, Math.round(px)));
}

import type { MetricPoint } from "@sysmon/protocol";

export interface UplotData {
  /** Unix saniye (uPlot sozlesmesi). */
  x: number[];
  avg: (number | null)[];
  min: (number | null)[];
  max: (number | null)[];
}

/**
 * API noktalarini uPlot dizilerine cevirir. BOSLUK = KESINTI: ardisik iki nokta arasi > 1,5 x bucket_seconds ise araya TEK
 * `null` noktasi (onceki noktadan bir bucket sonra) eklenir; uPlot `spanGaps: false` ile cizgiyi keser. Eksik veri
 * ASLA interpolasyonla doldurulmaz ve sifir cizilmez (proposal §9).
 */
export function toUplotData(points: MetricPoint[], bucketSeconds: number): UplotData {
  const out: UplotData = { x: [], avg: [], min: [], max: [] };
  let prev: number | null = null;
  for (const p of points) {
    const x = Math.round(Date.parse(p.t) / 1000);
    if (prev !== null && x - prev > 1.5 * bucketSeconds) {
      out.x.push(prev + bucketSeconds); out.avg.push(null); out.min.push(null); out.max.push(null);
    }
    out.x.push(x); out.avg.push(p.avg); out.min.push(p.min); out.max.push(p.max);
    prev = x;
  }
  return out;
}

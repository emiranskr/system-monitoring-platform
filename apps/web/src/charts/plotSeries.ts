import type uPlot from "uplot";

/** uPlot serileri: x, ortalama, min, maks. `spanGaps:false` = veri boslugu cizgiyi KESER (kesinti kapatilmaz); testle kilitli. */
export function plotSeries(label: string, accent: string): uPlot.Series[] {
  return [
    {},
    { label, stroke: accent, width: 2, spanGaps: false, points: { show: false } },
    { label: "min", stroke: "transparent", width: 0, spanGaps: false, points: { show: false } },
    { label: "maks", stroke: "transparent", width: 0, spanGaps: false, points: { show: false } },
  ];
}

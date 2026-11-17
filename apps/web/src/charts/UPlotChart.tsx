import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { useEffect, useRef } from "react";
import type { UplotData } from "./toUplotData";

export interface UPlotChartProps {
  data: UplotData;
  label: string;
  /** Eksen degeri bicimi. */
  format: (v: number) => string;
  height?: number;
}

const css = (name: string, fallback: string) => (typeof document === "undefined" ? fallback : getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback);

/**
 * uPlot sarmalayici: ortalama cizgisi + min/max bandi; bosluk (null) cizgiyi KESER (spanGaps:false); ayni sayfadaki
 * grafikler imleci esler (cursor.sync). Canvas erisilebilir degil: `role="img"` + ozet etiketi; asil erisilebilir alternatif
 * MetricChart'taki veri tablosudur.
 */
export function UPlotChart({ data, label, format, height = 220 }: UPlotChartProps) {
  const host = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const accent = css("--accent", "#6ba6ff");
    const text = css("--text-secondary", "#a3adbb");
    const grid = css("--border", "#2f3a49");
    const opts: uPlot.Options = {
      width: Math.max(el.clientWidth, 240),
      height,
      legend: { show: false },
      cursor: { sync: { key: "sysmon" }, drag: { x: false, y: false } }, // fircayla yakinlastirma KAPALI: dugmeler tek yol degil ama klavyeyle esdeger
      scales: { x: { time: true } },
      axes: [
        { stroke: text, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid } },
        { stroke: text, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, values: (_u, vals) => vals.map((v) => format(v)), size: 64 },
      ],
      series: [
        {},
        { label, stroke: accent, width: 2, spanGaps: false, points: { show: false } },
        { label: "min", stroke: "transparent", width: 0, spanGaps: false, points: { show: false } },
        { label: "maks", stroke: "transparent", width: 0, spanGaps: false, points: { show: false } },
      ],
      bands: [{ series: [3, 2], fill: `${accent}33` }],
    };
    plot.current = new uPlot(opts, [data.x, data.avg, data.min, data.max] as uPlot.AlignedData, el);
    const ro = new ResizeObserver(() => plot.current?.setSize({ width: Math.max(el.clientWidth, 240), height }));
    ro.observe(el);
    return () => { ro.disconnect(); plot.current?.destroy(); plot.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- grafik yalniz bicim/etiket degisince yeniden kurulur; veri asagida setData ile
  }, [label, height]);

  // Canli guncellemeler animasyon karesine kisilir (ayni karede birden cok setData tek cizime iner).
  useEffect(() => {
    const id = requestAnimationFrame(() => plot.current?.setData([data.x, data.avg, data.min, data.max] as uPlot.AlignedData));
    return () => cancelAnimationFrame(id);
  }, [data]);

  // data-gaps: veri dizisindeki KESINTI (null) sayisi — E2E ve hata ayiklama icin (gorunur davranis degil)
  const gaps = data.avg.filter((v) => v === null).length;
  return <div ref={host} role="img" aria-label={label} data-gaps={gaps} className="w-full overflow-hidden" />;
}

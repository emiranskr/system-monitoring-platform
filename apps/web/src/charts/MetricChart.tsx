import { useEffect, useMemo, useRef, useState } from "react";
import { SessionExpiredError } from "../api/client";
import { useMetricSeries } from "../api/deviceQueries";
import { ErrorState } from "../components/ErrorState";
import { formatClock, formatValue, type Unit } from "../lib/format";
import { maxPointsForWidth, type RangeId } from "./range";
import { toUplotData } from "./toUplotData";
import { UPlotChart } from "./UPlotChart";

/** Kapsayicinin piksel genisligi (ResizeObserver): API `max_points` icin. jsdom'da 0 -> varsayilan. */
function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export interface MetricChartProps {
  deviceId: string;
  metric: string;
  /** Erisilebilir ad (grafik `role="img"` etiketi) ve baslik. */
  title: string;
  unit: Unit;
  range: RangeId;
  /** Baslik gosterilsin mi (Ag sekmesinde ust baslik adaptordur). */
  hideTitle?: boolean;
}

/** Tek metrik: veri cekme + uPlot grafigi + ozet + erisilebilir veri tablosu. Bos/yukleniyor/hata durumlari acik. */
export function MetricChart({ deviceId, metric, title, unit, range, hideTitle }: MetricChartProps) {
  const [wrapRef, width] = useElementWidth<HTMLDivElement>();
  const q = useMetricSeries(deviceId, metric, range, maxPointsForWidth(width));
  const [showTable, setShowTable] = useState(false);
  const data = useMemo(() => (q.data ? toUplotData(q.data.points, q.data.bucket_seconds) : null), [q.data]);
  const fmt = (v: number) => formatValue(unit, v);

  let body;
  if (q.isPending) body = <p role="status" className="py-8 text-text-secondary">Yükleniyor…</p>;
  else if (q.isError) body = q.error instanceof SessionExpiredError ? null : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  else if (q.data.points.length === 0) body = <p className="py-8 text-text-secondary">Seçilen aralıkta veri yok.</p>;
  else {
    const pts = q.data.points;
    const last = pts[pts.length - 1]!;
    const min = Math.min(...pts.map((p) => p.min));
    const max = Math.max(...pts.map((p) => p.max));
    const avg = pts.reduce((s, p) => s + p.avg, 0) / pts.length;
    body = (
      <>
        <UPlotChart data={data!} label={title} format={fmt} />
        <p className="mt-2 text-sm tabular-nums text-text-secondary">
          Son {fmt(last.avg)} · Min {fmt(min)} · Ort {fmt(avg)} · Maks {fmt(max)}
        </p>
        <button
          type="button"
          aria-expanded={showTable}
          onClick={() => setShowTable((s) => !s)}
          className="mt-2 min-h-11 rounded-md border border-border bg-surface-2 px-3 text-sm hover:bg-surface-0"
        >
          {showTable ? "Tabloyu gizle" : "Tablo olarak göster"}
        </button>
        {showTable ? <ChartDataTable title={title} points={pts} fmt={fmt} /> : null}
      </>
    );
  }

  return (
    <section aria-label={title} className="rounded-lg border border-border bg-surface-1 p-4">
      {hideTitle ? null : <h3 className="mb-2 text-sm font-semibold text-text-secondary">{title}</h3>}
      <div ref={wrapRef}>{body}</div>
    </section>
  );
}

/** Grafikle AYNI veri, erisilebilir tablo olarak (ekran okuyucu/klavye icin birincil alternatif). */
function ChartDataTable({ title, points, fmt }: { title: string; points: { t: string; avg: number; min: number; max: number }[]; fmt: (v: number) => string }) {
  return (
    <div role="region" aria-label={`${title} veri tablosu (kaydırılabilir)`} tabIndex={0} className="mt-3 max-h-72 overflow-auto rounded-md border border-border">
      <table className="w-full text-left text-sm tabular-nums">
        <caption className="sr-only">{title} veri tablosu</caption>
        <thead className="sticky top-0 bg-surface-2">
          <tr><th scope="col" className="px-3 py-1.5">Zaman</th><th scope="col" className="px-3 py-1.5">Ort</th><th scope="col" className="px-3 py-1.5">Min</th><th scope="col" className="px-3 py-1.5">Maks</th></tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.t} className="border-t border-border">
              <td className="px-3 py-1">{formatClock(Date.parse(p.t))}</td>
              <td className="px-3 py-1">{fmt(p.avg)}</td>
              <td className="px-3 py-1">{fmt(p.min)}</td>
              <td className="px-3 py-1">{fmt(p.max)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

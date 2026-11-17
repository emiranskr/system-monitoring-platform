import type { DeviceSummary } from "@sysmon/protocol";
import { Link } from "react-router-dom";
import { SessionExpiredError } from "../api/client";
import { useDevices } from "../api/queries";
import { ErrorState } from "../components/ErrorState";
import { StatusBadge } from "../components/StatusBadge";
import { deriveFleetSummary, formatPct, STATUS_ORDER } from "../lib/fleet";

function TopList({ title, devices, pick }: { title: string; devices: DeviceSummary[]; pick: (d: DeviceSummary) => number | null }) {
  return (
    <section aria-label={title} className="rounded-lg border border-border bg-surface-1 p-4">
      <h2 className="mb-3 text-sm font-semibold text-text-secondary">{title}</h2>
      {devices.length === 0 ? (
        <p className="text-text-secondary">Veri yok</p>
      ) : (
        <ol className="space-y-1">
          {devices.map((d) => (
            <li key={d.id} className="flex items-baseline justify-between gap-3">
              <Link to={`/cihaz/${d.id}`} className="min-w-0 truncate text-accent hover:underline">{d.name}</Link>
              <span className="tabular-nums">{formatPct(pick(d))}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function OverviewPage() {
  const q = useDevices();
  if (q.isPending) return <p role="status" className="p-6 text-text-secondary">Yükleniyor…</p>;
  if (q.isError) return q.error instanceof SessionExpiredError ? null : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const s = deriveFleetSummary(q.data.devices);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-6">
      <h1 className="text-2xl font-semibold">Genel bakış</h1>
      {s.total === 0 ? (
        <p className="rounded-lg border border-border bg-surface-1 p-6 text-text-secondary">Henüz cihaz yok. Cihaz eklemek için Cihazlar sayfasını kullanın.</p>
      ) : (
        <>
          <section aria-label="Durum özeti" className="grid grid-cols-2 gap-3 md:grid-cols-5">
            {STATUS_ORDER.map((st) => (
              <div key={st} className="rounded-lg border border-border bg-surface-1 p-4">
                <dt className="mb-2"><StatusBadge status={st} /></dt>
                <dd className="text-3xl font-semibold tabular-nums">{s.counts[st]}</dd>
              </div>
            ))}
          </section>
          <div className="grid gap-4 md:grid-cols-3">
            <TopList title="En yüksek CPU" devices={s.topCpu} pick={(d) => d.cpu_pct} />
            <TopList title="En yüksek bellek" devices={s.topMem} pick={(d) => d.mem_pct} />
            <TopList title="En yüksek disk" devices={s.topDisk} pick={(d) => d.disk_used_pct} />
          </div>
        </>
      )}
    </div>
  );
}

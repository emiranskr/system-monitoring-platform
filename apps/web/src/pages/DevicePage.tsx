import * as Tabs from "@radix-ui/react-tabs";
import type { DeviceDetail } from "@sysmon/protocol";
import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { SessionExpiredError } from "../api/client";
import { useDevice, useMetricNames } from "../api/deviceQueries";
import { labelForAdapter, pickMetrics } from "../charts/metricMap";
import { MetricChart } from "../charts/MetricChart";
import { RangePicker } from "../charts/RangePicker";
import type { RangeId } from "../charts/range";
import { ErrorState } from "../components/ErrorState";
import { StatusBadge } from "../components/StatusBadge";
import { formatRelative } from "../lib/fleet";

const TABS = [
  ["genel", "Genel"], ["cpu", "CPU"], ["bellek", "Bellek"], ["depolama", "Depolama"], ["ag", "Ağ"], ["bilgi", "Bilgi"],
] as const;

const Missing = () => <p className="rounded-lg border border-border bg-surface-1 p-6 text-text-secondary">Bu donanımda yok.</p>;

function Info({ info }: { info: DeviceDetail["device_info"] }) {
  if (!info) return <p className="rounded-lg border border-border bg-surface-1 p-6 text-text-secondary">Cihaz bilgisi yok.</p>;
  const rows: [string, ReactNode][] = [
    ["Ana bilgisayar adı", info.hostname], ["İşletim sistemi", info.os], ["Ajan sürümü", info.agent_version],
    ["Ağ arayüzleri", info.adapters.map((a) => a.name).join(", ") || "—"], ["Diskler", info.volumes.map((v) => v.name).join(", ") || "—"],
    ["Ekran kartları", info.gpus.map((g) => g.name).join(", ") || "—"],
  ];
  return (
    <dl className="grid gap-x-6 gap-y-3 rounded-lg border border-border bg-surface-1 p-4 sm:grid-cols-[max-content_1fr]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-text-secondary">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function DevicePage() {
  const { id = "" } = useParams();
  const device = useDevice(id);
  const names = useMetricNames(id);
  const [range, setRange] = useState<RangeId>("1h");
  const [tab, setTab] = useState("genel");

  if (device.isPending) return <p role="status" className="p-6 text-text-secondary">Yükleniyor…</p>;
  if (device.isError) return device.error instanceof SessionExpiredError ? null : <ErrorState error={device.error} onRetry={() => void device.refetch()} />;
  const d = device.data;
  const m = pickMetrics(names.data?.metrics.map((x) => x.name) ?? []);
  const adapters = d.device_info?.adapters ?? [];

  const chart = (metric: string, title: string, unit: "pct" | "bytes_per_sec", hideTitle?: boolean) =>
    <MetricChart key={metric} deviceId={id} metric={metric} title={title} unit={unit} range={range} hideTitle={hideTitle} />;
  const waiting = names.isPending ? <p role="status" className="text-text-secondary">Metrikler yükleniyor…</p> : null;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 md:p-6">
      <Link to="/cihazlar" className="inline-flex min-h-11 items-center text-accent hover:underline">← Cihazlar</Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="min-w-0 break-words text-2xl font-semibold">{d.name}</h1>
        <StatusBadge status={d.status} />
        <span className="text-sm text-text-secondary">Son görülme: {formatRelative(d.last_seen_at, new Date())}</span>
      </div>

      <RangePicker value={range} onChange={setRange} />
      {names.isError && !(names.error instanceof SessionExpiredError) ? <ErrorState error={names.error} onRetry={() => void names.refetch()} /> : null}

      <Tabs.Root value={tab} onValueChange={setTab}>
        <Tabs.List aria-label="Cihaz bölümleri" className="flex gap-1 overflow-x-auto border-b border-border">
          {TABS.map(([v, label]) => (
            <Tabs.Trigger key={v} value={v} className="min-h-11 shrink-0 border-b-2 border-transparent px-4 text-sm font-medium text-text-secondary data-[state=active]:border-accent data-[state=active]:text-text-primary">
              {label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        <Tabs.Content value="genel" className="mt-4 grid gap-4 md:grid-cols-2">
          {waiting}
          {m.cpu ? chart(m.cpu, "CPU kullanımı", "pct") : null}
          {m.mem ? chart(m.mem, "Bellek kullanımı", "pct") : null}
          {!names.isPending && !m.cpu && !m.mem ? <Missing /> : null}
        </Tabs.Content>
        <Tabs.Content value="cpu" className="mt-4">{waiting}{m.cpu ? chart(m.cpu, "CPU kullanımı", "pct") : names.isPending ? null : <Missing />}</Tabs.Content>
        <Tabs.Content value="bellek" className="mt-4">{waiting}{m.mem ? chart(m.mem, "Bellek kullanımı", "pct") : names.isPending ? null : <Missing />}</Tabs.Content>
        <Tabs.Content value="depolama" className="mt-4 grid gap-4 md:grid-cols-2">
          {waiting}
          {m.disks.map((dk) => chart(dk.metric, `Disk ${dk.letter.toUpperCase()}: doluluk`, "pct"))}
          {!names.isPending && m.disks.length === 0 ? <Missing /> : null}
        </Tabs.Content>
        <Tabs.Content value="ag" className="mt-4 space-y-4">
          {waiting}
          {m.nets.map((n) => {
            const label = labelForAdapter(n.key, adapters);
            return (
              <div key={n.key} className="space-y-2">
                <h2 className="text-lg font-semibold">{label}</h2>
                <div className="grid gap-4 md:grid-cols-2">
                  {n.rx ? chart(n.rx, `${label} alınan`, "bytes_per_sec", true) : null}
                  {n.tx ? chart(n.tx, `${label} gönderilen`, "bytes_per_sec", true) : null}
                </div>
              </div>
            );
          })}
          {!names.isPending && m.nets.length === 0 ? <Missing /> : null}
        </Tabs.Content>
        <Tabs.Content value="bilgi" className="mt-4"><Info info={d.device_info} /></Tabs.Content>
      </Tabs.Root>
    </div>
  );
}

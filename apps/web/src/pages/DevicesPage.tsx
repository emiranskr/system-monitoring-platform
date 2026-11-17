import { CaretDown, CaretUp } from "@phosphor-icons/react";
import type { DeviceStatus, DeviceSummary } from "@sysmon/protocol";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { SessionExpiredError } from "../api/client";
import { useDevices } from "../api/queries";
import { ErrorState } from "../components/ErrorState";
import { StatusBadge } from "../components/StatusBadge";
import { Input } from "../components/ui/form";
import { foldSearch, formatPct, formatRelative, STATUS_LABEL, STATUS_ORDER } from "../lib/fleet";

type SortKey = "name" | "status" | "cpu_pct" | "mem_pct" | "disk_used_pct" | "last_seen_at";
type Dir = "ascending" | "descending";

const COLS: { key: SortKey; label: string; cls?: string }[] = [
  { key: "name", label: "Ad" },
  { key: "status", label: "Durum" },
  { key: "cpu_pct", label: "CPU" },
  { key: "mem_pct", label: "Bellek", cls: "hidden sm:table-cell" },
  { key: "disk_used_pct", label: "Disk", cls: "hidden sm:table-cell" },
  { key: "last_seen_at", label: "Son görülme" },
];

/** NULL degerler her iki yonde de SONA gider; esitlikte ada gore (kararli siralama). */
function compare(a: DeviceSummary, b: DeviceSummary, key: SortKey, dir: Dir): number {
  const va = key === "last_seen_at" ? (a.last_seen_at === null ? null : Date.parse(a.last_seen_at)) : key === "status" ? STATUS_ORDER.indexOf(a.status) : key === "name" ? a.name : a[key];
  const vb = key === "last_seen_at" ? (b.last_seen_at === null ? null : Date.parse(b.last_seen_at)) : key === "status" ? STATUS_ORDER.indexOf(b.status) : key === "name" ? b.name : b[key];
  if (va === null && vb === null) return a.name.localeCompare(b.name);
  if (va === null) return 1;
  if (vb === null) return -1;
  const c = typeof va === "string" ? va.localeCompare(vb as string, "tr") : (va as number) - (vb as number);
  return (dir === "ascending" ? c : -c) || a.name.localeCompare(b.name);
}

export function DevicesPage() {
  const q = useDevices();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<DeviceStatus | "all">("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: Dir } | null>(null);
  const now = new Date();

  const rows = useMemo(() => {
    if (!q.data) return [];
    const needle = foldSearch(search.trim());
    let list = q.data.devices.filter((d) => (status === "all" || d.status === status) && (needle === "" || foldSearch(d.name).includes(needle)));
    if (sort) list = [...list].sort((a, b) => compare(a, b, sort.key, sort.dir));
    return list;
  }, [q.data, search, status, sort]);

  if (q.isPending) return <p role="status" className="p-6 text-text-secondary">Yükleniyor…</p>;
  if (q.isError) return q.error instanceof SessionExpiredError ? null : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;

  function toggle(key: SortKey) {
    setSort((s) => (s && s.key === key ? { key, dir: s.dir === "ascending" ? "descending" : "ascending" } : { key, dir: "ascending" }));
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 md:p-6">
      <h1 className="text-2xl font-semibold">Cihazlar</h1>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-1">
          <label htmlFor="ara" className="mb-1 block text-sm font-medium">Cihaz ara</label>
          <Input id="ara" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Ad…" />
        </div>
        <div>
          <label htmlFor="durum" className="mb-1 block text-sm font-medium">Durum</label>
          <select id="durum" value={status} onChange={(e) => setStatus(e.target.value as DeviceStatus | "all")} className="min-h-11 rounded-md border border-border bg-surface-0 px-3 text-text-primary">
            <option value="all">Tümü</option>
            {STATUS_ORDER.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-border bg-surface-1 p-6 text-text-secondary">{q.data.devices.length === 0 ? "Henüz cihaz yok." : "Eşleşen cihaz yok."}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-left">
            <caption className="sr-only">Cihaz listesi</caption>
            <thead className="bg-surface-1 text-sm text-text-secondary">
              <tr>
                {COLS.map((c) => {
                  const active = sort?.key === c.key ? sort.dir : undefined;
                  return (
                    <th key={c.key} scope="col" aria-sort={active ?? "none"} className={`px-3 py-2 font-medium ${c.cls ?? ""}`}>
                      <button type="button" onClick={() => toggle(c.key)} className="inline-flex min-h-11 items-center gap-1 hover:text-text-primary">
                        {c.label}
                        {active === "ascending" ? <CaretUp size={14} aria-hidden="true" /> : active === "descending" ? <CaretDown size={14} aria-hidden="true" /> : null}
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id} className="border-t border-border">
                  <td className="max-w-40 px-3 py-2 sm:max-w-64"><Link to={`/cihaz/${d.id}`} className="block truncate text-accent hover:underline">{d.name}</Link></td>
                  <td className="px-3 py-2"><StatusBadge status={d.status} /></td>
                  <td className="px-3 py-2 tabular-nums">{formatPct(d.cpu_pct)}</td>
                  <td className="hidden px-3 py-2 tabular-nums sm:table-cell">{formatPct(d.mem_pct)}</td>
                  <td className="hidden px-3 py-2 tabular-nums sm:table-cell">{formatPct(d.disk_used_pct)}</td>
                  <td className="px-3 py-2 text-text-secondary">{formatRelative(d.last_seen_at, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

import type { Incident } from "@sysmon/protocol";
import { Link } from "react-router-dom";
import { formatValue, metricLabel } from "../../lib/alerts";
import { formatRelative } from "../../lib/fleet";
import { SeverityBadge } from "./SeverityBadge";

/** Olay listesi (aktif/gecmis). Kural ve cihaz adlari kullanici girdisidir: yalniz React metni olarak basilir (XSS yok). */
export function IncidentsTable({ incidents, resolved }: { incidents: Incident[]; resolved: boolean }) {
  if (incidents.length === 0) {
    return <p className="rounded-lg border border-border bg-surface-1 p-6 text-text-secondary">{resolved ? "Çözülmüş uyarı yok." : "Aktif uyarı yok."}</p>;
  }
  const now = new Date();
  return (
    <div role="region" aria-label={resolved ? "Geçmiş uyarılar (kaydırılabilir)" : "Aktif uyarılar (kaydırılabilir)"} tabIndex={0} className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">{resolved ? "Geçmiş uyarılar" : "Aktif uyarılar"}</caption>
        <thead className="bg-surface-1 text-sm text-text-secondary">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">Önem</th>
            <th scope="col" className="px-3 py-2 font-medium">Kural</th>
            <th scope="col" className="px-3 py-2 font-medium">Cihaz</th>
            <th scope="col" className="px-3 py-2 font-medium">Metrik</th>
            <th scope="col" className="px-3 py-2 font-medium">Değer</th>
            <th scope="col" className="px-3 py-2 font-medium">Başladı</th>
            {resolved ? <th scope="col" className="px-3 py-2 font-medium">Çözüldü</th> : null}
          </tr>
        </thead>
        <tbody>
          {incidents.map((i) => (
            <tr key={i.id} className="border-t border-border">
              <td className="px-3 py-2"><SeverityBadge severity={i.severity} /></td>
              <td className="px-3 py-2 break-words">{i.rule_name}</td>
              <td className="px-3 py-2"><Link to={`/cihaz/${i.device_id}`} className="inline-flex min-h-11 items-center text-accent hover:underline"><span className="min-w-0 truncate">{i.device_name}</span></Link></td>
              <td className="px-3 py-2">{metricLabel(i.metric)}</td>
              <td className="px-3 py-2 tabular-nums">{formatValue(i.last_value)}{i.peak_value !== null && i.peak_value !== i.last_value ? ` (tepe ${formatValue(i.peak_value)})` : ""}</td>
              <td className="px-3 py-2" title={i.opened_at}>{formatRelative(i.opened_at, now)}</td>
              {resolved ? <td className="px-3 py-2" title={i.resolved_at ?? ""}>{formatRelative(i.resolved_at, now)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

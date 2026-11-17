import type { QueryClient } from "@tanstack/react-query";
import type { DeviceDetail, DeviceSummary, DevicesResponse, SampleEventPayload } from "@sysmon/protocol";

const later = (a: string | null, b: string): string => (a !== null && Date.parse(a) > Date.parse(b) ? a : b);

/**
 * SSE `sample` olayini sorgu onbellegine yazar (sayfa yenilenmeden gorunur):
 *  - filo listesi satiri: cpu/bellek (olayda varsa), disk = olaydaki disk.*.used_pct'in EN YUKSEGI, son gorulme (geriye gitmez),
 *    durum online (iptal edilmis cihaz `revoked` KALIR);
 *  - olayda OLMAYAN alan eski degerini korur, NULL gelen alan NULL olur (donanim bilgisi yok);
 *  - liste onbellekte var ama cihaz yoksa liste yeniden cekilmek uzere GECERSIZ kilinir; liste hic yoksa hicbir sey yapilmaz;
 *  - cihaz detayi onbellekteyse durum/son gorulme guncellenir.
 */
export function applyEvent(qc: QueryClient, p: SampleEventPayload): void {
  const v = p.values;
  const disks = Object.entries(v).filter(([k]) => /^disk\.[^.]+\.used_pct$/.test(k)).map(([, x]) => x);

  const list = qc.getQueryData<DevicesResponse>(["devices"]);
  if (list) {
    if (!list.devices.some((d) => d.id === p.device_id)) {
      void qc.invalidateQueries({ queryKey: ["devices"] });
    } else {
      qc.setQueryData<DevicesResponse>(["devices"], {
        devices: list.devices.map((d): DeviceSummary => {
          if (d.id !== p.device_id) return d;
          const nonNull = disks.filter((x): x is number => x !== null);
          return {
            ...d,
            status: d.status === "revoked" ? "revoked" : "online",
            last_seen_at: later(d.last_seen_at, p.t),
            cpu_pct: "cpu.total" in v ? v["cpu.total"]! : d.cpu_pct,
            mem_pct: "mem.used_pct" in v ? v["mem.used_pct"]! : d.mem_pct,
            disk_used_pct: disks.length === 0 ? d.disk_used_pct : nonNull.length === 0 ? null : Math.max(...nonNull),
          };
        }),
      });
    }
  }

  const detail = qc.getQueryData<DeviceDetail>(["device", p.device_id]);
  if (detail) {
    qc.setQueryData<DeviceDetail>(["device", p.device_id], {
      ...detail,
      status: detail.status === "revoked" ? "revoked" : "online",
      last_seen_at: later(detail.last_seen_at, p.t),
    });
  }
}

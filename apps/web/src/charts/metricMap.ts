export interface PickedMetrics {
  cpu: string | null;
  mem: string | null;
  disks: { letter: string; metric: string }[];
  nets: { key: string; rx: string | null; tx: string | null }[];
}

/**
 * metric-names (gercek veriden kesif) -> sekmelere gruplama. Bilinmeyen metrikler (GPU vb., M4) yok sayilir; olmayan grup
 * null/bos kalir (arayuz "bu donanimda yok" gosterir, sifir cizmez).
 */
export function pickMetrics(names: string[]): PickedMetrics {
  const out: PickedMetrics = { cpu: null, mem: null, disks: [], nets: [] };
  const nets = new Map<string, { key: string; rx: string | null; tx: string | null }>();
  for (const n of names) {
    if (n === "cpu.total") out.cpu = n;
    else if (n === "mem.used_pct") out.mem = n;
    else {
      const d = /^disk\.([^.]+)\.used_pct$/.exec(n);
      if (d) { out.disks.push({ letter: d[1]!, metric: n }); continue; }
      const m = /^net\.([^.]+)\.(rx|tx)_bps$/.exec(n);
      if (m) {
        const e = nets.get(m[1]!) ?? { key: m[1]!, rx: null, tx: null };
        if (m[2] === "rx") e.rx = n; else e.tx = n;
        nets.set(m[1]!, e);
      }
    }
  }
  out.disks.sort((a, b) => a.letter.localeCompare(b.letter));
  out.nets = [...nets.values()].sort((a, b) => a.key.localeCompare(b.key));
  return out;
}

/**
 * Ag metrik anahtari ajanin dahili adlandirmasindan gelir (`net.<anahtar>.rx_bps`). device_info.adapters ile EN IYI CABAYLA
 * eslestirilir: adapter kimligi metrik adi kurallarina gore temizlenip (izinsiz karakter -> `_`) karsilastirilir. Eslesme yoksa
 * anahtarin kendisi gosterilir (tahmin edilmis ad uydurulmaz).
 */
export function labelForAdapter(key: string, adapters: { id: string; name: string }[]): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_\-:]/g, "_").toLowerCase();
  const hit = adapters.find((a) => clean(a.id) === key.toLowerCase());
  return hit ? hit.name : key;
}

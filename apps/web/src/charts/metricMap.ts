export interface PickedMetrics {
  cpu: string | null;
  mem: string | null;
  disks: { letter: string; metric: string }[];
  nets: { key: string; rx: string | null; tx: string | null }[];
  gpus: GpuMetrics[];
}

/** Bir GPU'nun (CanonicalId) mevcut metrik adlari; olmayan alan null (grafik cizilmez, sifir uydurulmaz). */
export interface GpuMetrics {
  id: string;
  util: string | null;
  vramUsed: string | null;
  vramTotal: string | null;
  temp: string | null;
  power: string | null;
  fan: string | null;
  core: string | null;
  mem: string | null;
}

const GPU_FIELDS: Record<string, keyof Omit<GpuMetrics, "id">> = {
  util_pct: "util", vram_used_bytes: "vramUsed", vram_total_bytes: "vramTotal", temp_c: "temp",
  power_w: "power", fan_pct: "fan", core_clock_mhz: "core", mem_clock_mhz: "mem",
};

/**
 * metric-names (gercek veriden kesif) -> sekmelere gruplama. Bilinmeyen metrikler (GPU vb., M4) yok sayilir; olmayan grup
 * null/bos kalir (arayuz "bu donanimda yok" gosterir, sifir cizmez).
 */
export function pickMetrics(names: string[]): PickedMetrics {
  const out: PickedMetrics = { cpu: null, mem: null, disks: [], nets: [], gpus: [] };
  const gpus = new Map<string, GpuMetrics>();
  const nets = new Map<string, { key: string; rx: string | null; tx: string | null }>();
  for (const n of names) {
    if (n === "cpu.total") out.cpu = n;
    else if (n === "mem.used_pct") out.mem = n;
    else {
      const d = /^disk\.([^.]+)\.used_pct$/.exec(n);
      if (d) { out.disks.push({ letter: d[1]!, metric: n }); continue; }
      const g = /^gpu\.([^.]+)\.([a-z_]+)$/.exec(n);
      const gf = g && Object.hasOwn(GPU_FIELDS, g[2]!) ? GPU_FIELDS[g[2]!] : undefined; // prototip anahtarlari (constructor...) eslesmez
      if (g && gf) {
        const e = gpus.get(g[1]!) ?? { id: g[1]!, util: null, vramUsed: null, vramTotal: null, temp: null, power: null, fan: null, core: null, mem: null };
        e[gf] = n;
        gpus.set(g[1]!, e);
        continue;
      }
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
  out.gpus = [...gpus.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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

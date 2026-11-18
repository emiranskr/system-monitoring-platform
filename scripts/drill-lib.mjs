/**
 * Yedek/geri yukleme tatbikati yardimcilari (saf; testli). Anlik goruntu: { tables: {ad: satirSayisi}, hypertables: [ad], caggs: [ad] }.
 * Karsilastirma BASARISIZLIGA egilimlidir: bos/eksik/uyusmayan goruntu asla "basarili" sayilmaz.
 */
export function compareSnapshots(source, restored, opts = {}) {
  const problems = [];
  const need = opts.requireNonEmpty ?? ["metric_samples"];
  const valid = (s) => s && typeof s === "object" && s.tables && typeof s.tables === "object" && Array.isArray(s.hypertables) && Array.isArray(s.caggs);
  if (!valid(source)) return { ok: false, problems: ["kaynak goruntusu gecersiz"] };
  if (!valid(restored)) return { ok: false, problems: ["geri yuklenen goruntu gecersiz"] };
  if (Object.keys(source.tables).length === 0) problems.push("kaynakta hic tablo yok");
  for (const [t, n] of Object.entries(source.tables)) {
    if (!(t in restored.tables)) problems.push(`tablo eksik: ${t}`);
    else if (restored.tables[t] !== n) problems.push(`satir sayisi uyusmuyor: ${t} kaynak=${n} geri=${restored.tables[t]}`);
  }
  for (const t of Object.keys(restored.tables)) if (!(t in source.tables)) problems.push(`beklenmeyen tablo: ${t}`);
  for (const t of need) if (!((source.tables[t] ?? 0) > 0)) problems.push(`kaynakta ${t} bos: tatbikat anlamsiz`);
  const sameSet = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
  if (!sameSet(source.hypertables, restored.hypertables)) problems.push(`hypertable listesi uyusmuyor: kaynak=[${source.hypertables}] geri=[${restored.hypertables}]`);
  if (source.hypertables.length === 0) problems.push("kaynakta hypertable yok");
  if (!sameSet(source.caggs, restored.caggs)) problems.push(`continuous aggregate listesi uyusmuyor: kaynak=[${source.caggs}] geri=[${restored.caggs}]`);
  return { ok: problems.length === 0, problems };
}

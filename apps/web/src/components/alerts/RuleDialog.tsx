import * as Dialog from "@radix-ui/react-dialog";
import { Plus, X } from "@phosphor-icons/react";
import type { AlertRuleInput, NotificationChannel } from "@sysmon/protocol";
import { useState } from "react";
import { ApiHttpError } from "../../api/client";
import { describeError } from "../ErrorState";
import { Button, Input, Label } from "../ui/form";
import { METRIC_PRESETS } from "../../lib/alerts";

const SELECT = "min-h-11 w-full rounded-md border border-border-control bg-surface-0 px-3 text-text-primary";
const OPERATORS = [">", ">=", "<", "<="] as const;

interface Props {
  channels: NotificationChannel[];
  onSubmit: (v: AlertRuleInput) => Promise<unknown>;
}

/** "Kural ekle" (owner|admin). Metrik/operator/agg izin listesinden secilir (serbest metin YOK); kapsam: tum cihazlar. */
export function RuleDialog({ channels, onSubmit }: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [metric, setMetric] = useState(METRIC_PRESETS[0]!.value);
  const [agg, setAgg] = useState<"avg" | "max">("avg");
  const [operator, setOperator] = useState<(typeof OPERATORS)[number]>(">");
  const [threshold, setThreshold] = useState("90");
  const [windowSec, setWindowSec] = useState("60");
  const [forSec, setForSec] = useState("120");
  const [hyst, setHyst] = useState("0");
  const [severity, setSeverity] = useState<"info" | "warning" | "critical">("warning");
  const [picked, setPicked] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setName(""); setMetric(METRIC_PRESETS[0]!.value); setAgg("avg"); setOperator(">"); setThreshold("90"); setWindowSec("60"); setForSec("120");
    setHyst("0"); setSeverity("warning"); setPicked([]); setErr(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const th = Number(threshold), win = Number(windowSec), f = Number(forSec), h = Number(hyst);
    if (!name.trim()) return setErr("Kural adı gerekli.");
    if (threshold.trim() === "" || !Number.isFinite(th)) return setErr("Eşik sayı olmalı.");
    if (!Number.isInteger(win) || win < 15 || win > 3600) return setErr("Pencere 15 ile 3600 sn arasında tam sayı olmalı.");
    if (!Number.isInteger(f) || f < 0 || f > 86400) return setErr("Süre 0 ile 86400 sn arasında tam sayı olmalı.");
    if (!Number.isFinite(h) || h < 0) return setErr("Histerezis negatif olamaz.");
    setErr(null);
    setBusy(true);
    try {
      await onSubmit({ name: name.trim(), metric, agg, window_seconds: win, operator, threshold: th, hysteresis: h, for_seconds: f, severity, scope_device_ids: null, channel_ids: picked, enabled: true });
      setOpen(false);
      reset();
    } catch (e2) {
      setErr(e2 instanceof ApiHttpError && e2.status === 400 ? "Girdiler geçersiz veya seçilen kanal bulunamadı." : describeError(e2).detail);
    } finally { setBusy(false); }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <Dialog.Trigger asChild><Button type="button"><Plus size={16} aria-hidden="true" className="mr-1.5" />Kural ekle</Button></Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60" />
        <Dialog.Content aria-describedby="kural-aciklama" className="fixed left-1/2 top-1/2 max-h-[90vh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-surface-1 p-6 shadow-xl">
          <div className="flex items-start justify-between gap-4">
            <Dialog.Title className="text-lg font-semibold">Uyarı kuralı ekle</Dialog.Title>
            <Dialog.Close asChild><button type="button" aria-label="Kapat" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md hover:bg-surface-2"><X size={18} aria-hidden="true" /></button></Dialog.Close>
          </div>
          <Dialog.Description id="kural-aciklama" className="mt-1 text-sm text-text-secondary">Kural tüm cihazlara uygulanır. Eşik, belirtilen süre boyunca aşılırsa uyarı açılır.</Dialog.Description>
          <form onSubmit={(e) => void submit(e)} className="mt-4 space-y-3" noValidate>
            <div><Label htmlFor="r-ad">Kural adı</Label><Input id="r-ad" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></div>
            <div><Label htmlFor="r-metrik">Metrik</Label>
              <select id="r-metrik" value={metric} onChange={(e) => setMetric(e.target.value)} className={SELECT}>
                {METRIC_PRESETS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label htmlFor="r-agg">Toplama</Label>
                <select id="r-agg" value={agg} onChange={(e) => setAgg(e.target.value as "avg" | "max")} className={SELECT}><option value="avg">Ortalama</option><option value="max">Maksimum</option></select></div>
              <div><Label htmlFor="r-op">Koşul</Label>
                <select id="r-op" value={operator} onChange={(e) => setOperator(e.target.value as (typeof OPERATORS)[number])} className={SELECT}>
                  {OPERATORS.map((o) => <option key={o} value={o}>{o}</option>)}</select></div>
              <div><Label htmlFor="r-esik">Eşik</Label><Input id="r-esik" inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} /></div>
              <div><Label htmlFor="r-hist">Histerezis</Label><Input id="r-hist" inputMode="decimal" value={hyst} onChange={(e) => setHyst(e.target.value)} /></div>
              <div><Label htmlFor="r-pencere">Pencere (sn)</Label><Input id="r-pencere" inputMode="numeric" value={windowSec} onChange={(e) => setWindowSec(e.target.value)} /></div>
              <div><Label htmlFor="r-sure">Süre (sn)</Label><Input id="r-sure" inputMode="numeric" value={forSec} onChange={(e) => setForSec(e.target.value)} /></div>
            </div>
            <div><Label htmlFor="r-onem">Önem</Label>
              <select id="r-onem" value={severity} onChange={(e) => setSeverity(e.target.value as "info" | "warning" | "critical")} className={SELECT}>
                <option value="info">Bilgi</option><option value="warning">Uyarı</option><option value="critical">Kritik</option></select></div>
            <fieldset className="rounded-md border border-border p-3">
              <legend className="px-1 text-sm font-medium">Bildirim kanalları</legend>
              {channels.length === 0 ? <p className="text-sm text-text-secondary">Henüz kanal yok (önce Kanallar sekmesinden ekleyin).</p> : channels.map((c) => (
                <label key={c.id} className="flex min-h-11 items-center gap-2">
                  <input type="checkbox" className="h-5 w-5" checked={picked.includes(c.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, c.id] : p.filter((x) => x !== c.id)))} />
                  <span className="min-w-0 break-words">{c.name}</span>
                </label>
              ))}
            </fieldset>
            {err ? <p role="alert" className="text-sm text-status-crit">{err}</p> : null}
            <div className="flex justify-end gap-2">
              <Dialog.Close asChild><Button type="button" variant="ghost">Vazgeç</Button></Dialog.Close>
              <Button type="submit" disabled={busy}>{busy ? "Kaydediliyor…" : "Kaydet"}</Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

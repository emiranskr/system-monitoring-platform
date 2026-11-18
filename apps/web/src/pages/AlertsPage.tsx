import * as Tabs from "@radix-ui/react-tabs";
import type { AlertRule, NotificationChannel } from "@sysmon/protocol";
import { useState } from "react";
import { ApiHttpError, SessionExpiredError } from "../api/client";
import { useAlertMutations, useAlertRules, useChannels, useIncidents } from "../api/alertQueries";
import { ChannelDialog } from "../components/alerts/ChannelDialog";
import { IncidentsTable } from "../components/alerts/IncidentsTable";
import { RuleDialog } from "../components/alerts/RuleDialog";
import { SeverityBadge } from "../components/alerts/SeverityBadge";
import { describeError, ErrorState } from "../components/ErrorState";
import { Button } from "../components/ui/form";
import { describeRule } from "../lib/alerts";
import { useSession } from "../session/SessionProvider";

const TABS = [["aktif", "Aktif"], ["gecmis", "Geçmiş"], ["kurallar", "Kurallar"], ["kanallar", "Kanallar"]] as const;
const Loading = () => <p role="status" className="p-4 text-text-secondary">Yükleniyor…</p>;

function Section<T>({ q, children }: { q: { isPending: boolean; isError: boolean; error: unknown; data: T | undefined; refetch: () => unknown }; children: (d: T) => React.ReactNode }) {
  if (q.isPending) return <Loading />;
  if (q.isError) return q.error instanceof SessionExpiredError ? null : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return <>{children(q.data as T)}</>;
}

function RulesPanel({ canWrite, channels }: { canWrite: boolean; channels: NotificationChannel[] }) {
  const q = useAlertRules();
  const m = useAlertMutations();
  const [confirm, setConfirm] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; ids: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(p: Promise<unknown>) {
    setError(null);
    try { await p; } catch (e) { setError(describeError(e).detail); }
  }
  return (
    <div className="space-y-3">
      {canWrite ? <div className="flex justify-end"><RuleDialog channels={channels} onSubmit={(v) => m.createRule.mutateAsync(v)} /></div> : null}
      {error ? <p role="alert" className="text-sm text-status-crit">{error}</p> : null}
      <Section q={q}>
        {(d) => (
          <ul aria-label="Uyarı kuralları" className="space-y-2">
            {d.rules.map((r: AlertRule) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-surface-1 p-3">
                <div className="min-w-0 flex-1 basis-64">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 break-words font-medium">{r.name}</span>
                    {r.builtin ? <span className="rounded border border-border px-1.5 text-xs text-text-secondary">Yerleşik</span> : null}
                    <SeverityBadge severity={r.severity} />
                    <span className="text-sm text-text-secondary">{r.enabled ? "Etkin" : "Devre dışı"}</span>
                  </div>
                  <p className="mt-1 break-words text-sm text-text-secondary">{describeRule(r)} · {r.channel_ids.length} kanal</p>
                </div>
                {canWrite ? (
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="ghost" onClick={() => setEditing({ id: r.id, ids: [...r.channel_ids] })}>Kanalları düzenle<span className="sr-only"> — {r.name}</span></Button>
                    <Button type="button" variant="ghost" onClick={() => void run(m.patchRule.mutateAsync({ id: r.id, patch: { enabled: !r.enabled } }))}>
                      {r.enabled ? "Devre dışı bırak" : "Etkinleştir"}<span className="sr-only"> — {r.name}</span>
                    </Button>
                    {!r.builtin ? (
                      confirm === r.id ? (
                        <>
                          <Button type="button" onClick={() => { setConfirm(null); void run(m.deleteRule.mutateAsync(r.id)); }}>Evet, sil<span className="sr-only"> — {r.name}</span></Button>
                          <Button type="button" variant="ghost" onClick={() => setConfirm(null)}>Vazgeç</Button>
                        </>
                      ) : <Button type="button" variant="ghost" onClick={() => setConfirm(r.id)}>Sil<span className="sr-only"> — {r.name}</span></Button>
                    ) : null}
                  </div>
                ) : null}
                {canWrite && editing?.id === r.id ? (
                  <fieldset className="basis-full space-y-2 border-t border-border pt-2">
                    <legend className="text-sm font-medium">Bildirim kanalları — {r.name}</legend>
                    {channels.length === 0 ? <p className="text-sm text-text-secondary">Önce Kanallar sekmesinden bir kanal ekleyin.</p> : channels.map((c) => (
                      <label key={c.id} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={editing.ids.includes(c.id)}
                          onChange={(e) => setEditing({ id: r.id, ids: e.target.checked ? [...editing.ids, c.id] : editing.ids.filter((x) => x !== c.id) })} />
                        {c.name}
                      </label>
                    ))}
                    <div className="flex gap-2">
                      <Button type="button" onClick={() => { const known = new Set(channels.map((c) => c.id)); const ids = editing.ids.filter((x) => known.has(x)); setEditing(null); void run(m.patchRule.mutateAsync({ id: r.id, patch: { channel_ids: ids } })); }}>Kanalları kaydet</Button>
                      <Button type="button" variant="ghost" onClick={() => setEditing(null)}>Vazgeç</Button>
                    </div>
                  </fieldset>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function ChannelsPanel({ canWrite }: { canWrite: boolean }) {
  const q = useChannels();
  const m = useAlertMutations();
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  async function test(id: string) {
    setError(null); setNote(null);
    try { await m.testChannel.mutateAsync(id); setNote("Test bildirimi kuyruğa alındı."); }
    catch (e) { setError(e instanceof ApiHttpError && e.status === 429 ? "Çok fazla test gönderildi; biraz bekleyin." : describeError(e).detail); }
  }
  async function del(id: string) {
    setError(null); setNote(null); setConfirm(null);
    try { await m.deleteChannel.mutateAsync(id); } catch (e) { setError(describeError(e).detail); }
  }
  const summary = (c: NotificationChannel) => ("port" in c.summary ? `${c.summary.host}:${c.summary.port} · ${c.summary.recipients} alıcı` : c.summary.host);

  return (
    <div className="space-y-3">
      {canWrite ? <div className="flex justify-end"><ChannelDialog onSubmit={(v) => m.createChannel.mutateAsync(v)} /></div> : null}
      {note ? <p role="status" className="text-sm text-status-ok">{note}</p> : null}
      {error ? <p role="alert" className="text-sm text-status-crit">{error}</p> : null}
      <Section q={q}>
        {(d) => d.channels.length === 0 ? (
          <p className="rounded-lg border border-border bg-surface-1 p-6 text-text-secondary">Henüz bildirim kanalı yok.</p>
        ) : (
          <ul aria-label="Bildirim kanalları" className="space-y-2">
            {d.channels.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-surface-1 p-3">
                <div className="min-w-0 flex-1 basis-64">
                  <span className="min-w-0 break-words font-medium">{c.name}</span>
                  <p className="mt-1 break-words text-sm text-text-secondary">{c.type === "webhook" ? "Webhook" : "E-posta"} · {summary(c)}</p>
                </div>
                {canWrite ? (
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="ghost" onClick={() => void test(c.id)}>Test gönder<span className="sr-only"> — {c.name}</span></Button>
                    {confirm === c.id ? (
                      <>
                        <Button type="button" onClick={() => void del(c.id)}>Evet, sil<span className="sr-only"> — {c.name}</span></Button>
                        <Button type="button" variant="ghost" onClick={() => setConfirm(null)}>Vazgeç</Button>
                      </>
                    ) : <Button type="button" variant="ghost" onClick={() => setConfirm(c.id)}>Sil<span className="sr-only"> — {c.name}</span></Button>}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

export function AlertsPage() {
  const { user } = useSession();
  const canWrite = user?.role === "owner" || user?.role === "admin";
  const [tab, setTab] = useState("aktif");
  const open = useIncidents("open");
  const resolved = useIncidents("resolved");
  const channels = useChannels();

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 md:p-6">
      <h1 className="text-2xl font-semibold">Uyarılar</h1>
      <Tabs.Root value={tab} onValueChange={setTab}>
        <Tabs.List aria-label="Uyarı bölümleri" className="flex gap-1 overflow-x-auto border-b border-border">
          {TABS.map(([v, label]) => (
            <Tabs.Trigger key={v} value={v} className="min-h-11 shrink-0 border-b-2 border-transparent px-4 text-sm font-medium text-text-secondary data-[state=active]:border-accent data-[state=active]:text-text-primary">
              {label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Tabs.Content value="aktif" className="mt-4"><Section q={open}>{(d) => <IncidentsTable incidents={d.incidents} resolved={false} />}</Section></Tabs.Content>
        <Tabs.Content value="gecmis" className="mt-4"><Section q={resolved}>{(d) => <IncidentsTable incidents={d.incidents} resolved />}</Section></Tabs.Content>
        <Tabs.Content value="kurallar" className="mt-4"><RulesPanel canWrite={canWrite} channels={channels.data?.channels ?? []} /></Tabs.Content>
        <Tabs.Content value="kanallar" className="mt-4"><ChannelsPanel canWrite={canWrite} /></Tabs.Content>
      </Tabs.Root>
    </div>
  );
}

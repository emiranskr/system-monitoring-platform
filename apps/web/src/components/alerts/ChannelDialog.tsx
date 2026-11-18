import * as Dialog from "@radix-ui/react-dialog";
import { Plus, X } from "@phosphor-icons/react";
import type { ChannelInput } from "@sysmon/protocol";
import { useState } from "react";
import { ApiHttpError } from "../../api/client";
import { channelErrorText } from "../../lib/alerts";
import { describeError } from "../ErrorState";
import { Button, Input, Label } from "../ui/form";

const SELECT = "min-h-11 w-full rounded-md border border-border-control bg-surface-0 px-3 text-text-primary";

/**
 * "Kanal ekle" (owner|admin): webhook (URL + istege bagli imza sirri) veya e-posta (SMTP). Sir alanlari password turundedir; gonderim
 * sonrasi (basari/vazgec) tum alanlar bellekten SIFIRLANIR ve sirlar hicbir yerde geri gosterilmez (API de geri dondurmez).
 */
export function ChannelDialog({ onSubmit }: { onSubmit: (v: ChannelInput) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<"webhook" | "email">("webhook");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("587");
  const [secure, setSecure] = useState(false);
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setType("webhook"); setName(""); setUrl(""); setSecret(""); setHost(""); setPort("587"); setSecure(false); setUser(""); setPass(""); setFrom(""); setTo(""); setErr(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setErr("Kanal adı gerekli.");
    let body: ChannelInput;
    if (type === "webhook") {
      if (!/^https:\/\//i.test(url.trim())) return setErr("Webhook adresi https:// ile başlamalı.");
      body = { type: "webhook", name: name.trim(), url: url.trim(), ...(secret ? { secret } : {}) };
    } else {
      const p = Number(port);
      const recipients = to.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
      if (!host.trim()) return setErr("SMTP sunucusu gerekli.");
      if (!Number.isInteger(p) || p < 1 || p > 65535) return setErr("Port 1 ile 65535 arasında olmalı.");
      if (!from.trim() || recipients.length === 0) return setErr("Gönderen ve en az bir alıcı gerekli.");
      body = { type: "email", name: name.trim(), host: host.trim(), port: p, secure, ...(user ? { user, pass } : {}), from: from.trim(), to: recipients };
    }
    setErr(null);
    setBusy(true);
    try {
      await onSubmit(body);
      setOpen(false);
      reset();                                                       // sirlar bellekten silinir
    } catch (e2) {
      setErr(e2 instanceof ApiHttpError ? channelErrorText(e2.status, e2.code) : describeError(e2).detail);
    } finally { setBusy(false); }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <Dialog.Trigger asChild><Button type="button"><Plus size={16} aria-hidden="true" className="mr-1.5" />Kanal ekle</Button></Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60" />
        <Dialog.Content aria-describedby="kanal-aciklama" className="fixed left-1/2 top-1/2 max-h-[90vh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-surface-1 p-6 shadow-xl">
          <div className="flex items-start justify-between gap-4">
            <Dialog.Title className="text-lg font-semibold">Bildirim kanalı ekle</Dialog.Title>
            <Dialog.Close asChild><button type="button" aria-label="Kapat" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md hover:bg-surface-2"><X size={18} aria-hidden="true" /></button></Dialog.Close>
          </div>
          <Dialog.Description id="kanal-aciklama" className="mt-1 text-sm text-text-secondary">Adresler ve parolalar şifreli saklanır; bir daha gösterilmez. Özel/yerel ağ adresleri güvenlik nedeniyle kullanılamaz.</Dialog.Description>
          <form onSubmit={(e) => void submit(e)} className="mt-4 space-y-3" noValidate autoComplete="off">
            <div><Label htmlFor="k-tur">Tür</Label>
              <select id="k-tur" value={type} onChange={(e) => setType(e.target.value as "webhook" | "email")} className={SELECT}><option value="webhook">Webhook</option><option value="email">E-posta (SMTP)</option></select></div>
            <div><Label htmlFor="k-ad">Kanal adı</Label><Input id="k-ad" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></div>
            {type === "webhook" ? (
              <>
                <div><Label htmlFor="k-url">Webhook adresi (https)</Label><Input id="k-url" type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" autoComplete="off" /></div>
                <div><Label htmlFor="k-imza">İmza sırrı (isteğe bağlı)</Label><Input id="k-imza" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" /></div>
              </>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2"><Label htmlFor="k-host">SMTP sunucusu</Label><Input id="k-host" value={host} onChange={(e) => setHost(e.target.value)} autoComplete="off" /></div>
                  <div><Label htmlFor="k-port">Port</Label><Input id="k-port" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} /></div>
                </div>
                <label className="flex min-h-11 items-center gap-2"><input type="checkbox" className="h-5 w-5" checked={secure} onChange={(e) => setSecure(e.target.checked)} /><span>Örtük TLS (465 tarzı); işaretsizse STARTTLS zorunlu</span></label>
                <div className="grid grid-cols-2 gap-3">
                  <div><Label htmlFor="k-user">Kullanıcı (isteğe bağlı)</Label><Input id="k-user" value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" /></div>
                  <div><Label htmlFor="k-pass">Parola</Label><Input id="k-pass" type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" /></div>
                </div>
                <div><Label htmlFor="k-from">Gönderen</Label><Input id="k-from" type="email" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
                <div><Label htmlFor="k-to">Alıcılar (virgülle ayırın, en çok 10)</Label><Input id="k-to" value={to} onChange={(e) => setTo(e.target.value)} /></div>
              </>
            )}
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

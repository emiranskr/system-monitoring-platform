import * as Dialog from "@radix-ui/react-dialog";
import { Copy, Plus, X } from "@phosphor-icons/react";
import { useState } from "react";
import { describeError } from "./ErrorState";
import { Button, Input, Label } from "./ui/form";
import { useCreateEnrollmentToken } from "../api/useCreateEnrollmentToken";
import { useSession } from "../session/SessionProvider";

const MIN_TTL = 5, MAX_TTL = 1440;

/**
 * "Cihaz ekle": owner|admin icin tek kullanimlik enrollment token uretir. Token YALNIZ bir kez gosterilir; diyalog kapaninca
 * (Esc dahil) DOM'dan ve mutasyon onbelleginden silinir. Pano erisimi reddedilirse secilebilir metin yedegi vardir.
 */
export function AddDeviceDialog() {
  const { user } = useSession();
  const create = useCreateEnrollmentToken();
  const [open, setOpen] = useState(false);
  const [ttl, setTtl] = useState("60");
  const [formError, setFormError] = useState<string | null>(null);
  const [copy, setCopy] = useState<"idle" | "ok" | "fail">("idle");

  if (!user || (user.role !== "owner" && user.role !== "admin")) return null;

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) { create.reset(); setFormError(null); setCopy("idle"); setTtl("60"); } // token bellekten silinir
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const n = Number(ttl);
    if (!Number.isInteger(n) || n < MIN_TTL || n > MAX_TTL) { setFormError(`Geçerlilik süresi ${MIN_TTL} ile ${MAX_TTL} dakika arasında tam sayı olmalı.`); return; }
    setFormError(null);
    create.mutate({ ttl_minutes: n });
  }

  async function copyToken(token: string) {
    try { await navigator.clipboard.writeText(token); setCopy("ok"); } catch { setCopy("fail"); }
  }

  const token = create.data?.token;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger asChild>
        <Button type="button"><Plus size={16} aria-hidden="true" className="mr-1.5" />Cihaz ekle</Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60" />
        <Dialog.Content aria-describedby="cihaz-ekle-aciklama" className="fixed left-1/2 top-1/2 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface-1 p-6 shadow-xl">
          <div className="mb-4 flex items-start justify-between gap-4">
            <Dialog.Title className="text-lg font-semibold">Cihaz ekle</Dialog.Title>
            <Dialog.Close className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md hover:bg-surface-2" aria-label="Kapat"><X size={18} aria-hidden="true" /></Dialog.Close>
          </div>
          <Dialog.Description id="cihaz-ekle-aciklama" className="mb-4 text-sm text-text-secondary">
            Ajan kurulumunda kullanılacak tek kullanımlık kayıt token'ı üretin.
          </Dialog.Description>

          {token ? (
            <div className="space-y-3">
              <p className="text-sm text-status-warn">Bu token yalnızca şimdi görüntülenir ve tek kullanımlıktır. Kapattıktan sonra yeniden görülemez.</p>
              <code className="block select-all break-all rounded-md border border-border bg-surface-0 p-3 text-sm">{token}</code>
              <p className="text-sm text-text-secondary">Geçerlilik sonu: {new Date(create.data!.expires_at).toLocaleString("tr-TR")}</p>
              <div className="flex items-center gap-3">
                <Button type="button" variant="ghost" onClick={() => void copyToken(token)}><Copy size={16} aria-hidden="true" className="mr-1.5" />Kopyala</Button>
                {copy === "ok" ? <span role="status">Kopyalandı</span> : null}
                {copy === "fail" ? <span role="status" className="text-status-warn">Kopyalanamadı; metni seçip elle kopyalayın.</span> : null}
              </div>
            </div>
          ) : (
            <form onSubmit={onSubmit} noValidate className="space-y-4">
              <div>
                <Label htmlFor="ttl">Geçerlilik süresi (dakika)</Label>
                <Input id="ttl" type="number" inputMode="numeric" min={MIN_TTL} max={MAX_TTL} value={ttl} onChange={(e) => setTtl(e.target.value)} />
              </div>
              {formError ? <p role="alert" className="text-status-crit">{formError}</p> : null}
              {create.isError ? <p role="alert" className="text-status-crit">{describeError(create.error).title}: {describeError(create.error).detail}</p> : null}
              <Button type="submit" disabled={create.isPending}>{create.isPending ? "Oluşturuluyor…" : "Token oluştur"}</Button>
            </form>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

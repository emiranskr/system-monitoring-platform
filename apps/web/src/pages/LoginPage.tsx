import { useState, type FormEvent } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { ApiHttpError, ContractError, NetworkError } from "../api/client";
import { Button, Input, Label } from "../components/ui/form";
import { safeNext } from "../session/safeNext";
import { useSession } from "../session/SessionProvider";

function messageFor(e: unknown): string {
  if (e instanceof ApiHttpError) {
    if (e.status === 401) return "E-posta veya parola hatalı.";
    if (e.status === 429) return "Çok fazla deneme yapıldı. Biraz bekleyip yeniden deneyin.";
    if (e.status === 403) return "Bu adresten giriş yapılamıyor (izin verilmeyen köken).";
    return "Giriş yapılamadı. Yeniden deneyin.";
  }
  if (e instanceof NetworkError) return "Sunucuya ulaşılamıyor. Bağlantınızı kontrol edin.";
  if (e instanceof ContractError) return "Sunucudan beklenmeyen yanıt alındı.";
  return "Giriş yapılamadı. Yeniden deneyin.";
}

export function LoginPage() {
  const session = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (session.status === "authed") return <Navigate to={next} replace />;

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await session.login(email.trim(), password);
      navigate(next, { replace: true });
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-0 p-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm rounded-lg border border-border bg-surface-1 p-6" noValidate>
        <h1 className="mb-6 text-xl font-semibold text-text-primary">Giriş</h1>
        <div className="mb-4">
          <Label htmlFor="email">E-posta</Label>
          <Input id="email" name="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="mb-4">
          <Label htmlFor="password">Parola</Label>
          <Input id="password" name="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error ? <p role="alert" className="mb-4 rounded-md border border-status-crit p-3 text-status-crit">{error}</p> : null}
        <Button type="submit" className="w-full" disabled={busy}>{busy ? "Giriş yapılıyor…" : "Giriş yap"}</Button>
      </form>
    </main>
  );
}

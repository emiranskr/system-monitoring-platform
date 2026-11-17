import { ApiHttpError, ContractError, NetworkError, SessionExpiredError } from "../api/client";

export interface ErrorDescription { title: string; detail: string }

/** Hata -> kullaniciya gosterilecek Turkce metin. 404 varlik ipucu vermez; sozlesme ihlali acik hata olarak gorunur. */
export function describeError(e: unknown): ErrorDescription {
  if (e instanceof SessionExpiredError) return { title: "Oturum sona erdi", detail: "Devam etmek için yeniden giriş yapın." };
  if (e instanceof NetworkError) return { title: "Sunucuya ulaşılamıyor", detail: "Bağlantınızı kontrol edip yeniden deneyin." };
  if (e instanceof ContractError) return { title: "Sunucudan beklenmeyen yanıt alındı", detail: "Panel ile sunucu sürümleri uyumsuz olabilir. Sayfayı yenileyin; sorun sürerse yöneticinize bildirin." };
  if (e instanceof ApiHttpError) {
    if (e.status === 403) return { title: "Yetkiniz yok", detail: "Bu işlem için gerekli role sahip değilsiniz." };
    if (e.status === 404) return { title: "Bulunamadı", detail: "Aradığınız kayıt yok veya erişiminiz yok." };
    if (e.status === 429) return { title: "Çok fazla istek", detail: "Biraz bekleyip yeniden deneyin." };
    return { title: "Sunucu hatası", detail: "İstek tamamlanamadı. Yeniden deneyin." };
  }
  return { title: "Beklenmeyen hata", detail: "Bir sorun oluştu. Sayfayı yenileyin." };
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const d = describeError(error);
  return (
    <div role="alert" className="mx-auto my-10 max-w-md rounded-lg border border-border bg-surface-1 p-6">
      <h2 className="text-lg font-semibold text-status-crit">{d.title}</h2>
      <p className="mt-2 text-text-secondary">{d.detail}</p>
      {onRetry ? (
        <button type="button" onClick={onRetry} className="mt-4 min-h-11 rounded-md border border-border bg-surface-2 px-4 text-text-primary hover:bg-surface-0">
          Yeniden dene
        </button>
      ) : null}
    </div>
  );
}

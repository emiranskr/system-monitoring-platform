import type { z } from "zod";

/** Sunucu 4xx/5xx yaniti (401-oturum haric). `code`: govdedeki `error` alani, okunamazsa "unknown". */
export class ApiHttpError extends Error {
  constructor(public status: number, public code: string) { super(`${status} ${code}`); this.name = "ApiHttpError"; }
}
/** Oturum yok/gecersiz/suresi dolmus (401 + unauthorized): kullaniciyi giris ekranina goturur. */
export class SessionExpiredError extends Error {
  constructor() { super("session_expired"); this.name = "SessionExpiredError"; }
}
/** Yanit HTTP olarak basarili ama packages/protocol semasina UYMUYOR: sessizce bozulmak yerine acik hata. */
export class ContractError extends Error {
  constructor(public path: string, detail: string) { super(`Sozlesme ihlali (${path}): ${detail}`); this.name = "ContractError"; }
}
/** Sunucuya hic ulasilamadi (DNS/baglanti/CORS). */
export class NetworkError extends Error {
  constructor() { super("network"); this.name = "NetworkError"; }
}

export interface ApiInit { method?: "GET" | "POST"; json?: unknown; signal?: AbortSignal }

/**
 * Tum panel API cagrilari buradan gecer: `credentials: "same-origin"` (oturum cerezi, JS token gormez), yanit zod semasiyla
 * calisma zamaninda dogrulanir. 401 (oturum) -> SessionExpiredError; giris hatasi (`invalid_credentials`) ApiHttpError'dur.
 */
export async function apiFetch<T>(path: string, schema: z.ZodType<T>, init: ApiInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? "GET",
      credentials: "same-origin",
      headers: { accept: "application/json", ...(init.json !== undefined ? { "content-type": "application/json" } : {}) },
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new NetworkError();
  }

  if (!res.ok) {
    let code = "unknown";
    try {
      const b = (await res.json()) as { error?: unknown };
      if (typeof b.error === "string") code = b.error;
    } catch { /* govde JSON degil */ }
    if (res.status === 401 && code !== "invalid_credentials") throw new SessionExpiredError();
    throw new ApiHttpError(res.status, code);
  }

  let data: unknown = undefined;
  if (res.status !== 204) {
    try { data = await res.json(); } catch { throw new ContractError("(govde)", "yanit JSON degil"); }
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ContractError(issue ? issue.path.join(".") || "(kok)" : "(bilinmiyor)", issue?.message ?? "gecersiz");
  }
  return parsed.data;
}

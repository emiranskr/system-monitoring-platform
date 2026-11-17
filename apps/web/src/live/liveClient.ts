import { SampleEventPayloadSchema, type SampleEventPayload } from "@sysmon/protocol";

export type LiveStatus = "connecting" | "live" | "down" | "closed";

export interface LiveBackoff {
  baseMs: number;
  maxMs: number;
  /** Gecikmeye uygulanan rastgelelik (varsayilan: yariya kadar rastgele kisaltma). Testlerde kimlik. */
  jitter: (delayMs: number) => number;
}

export interface LiveClientOptions {
  url: string;
  EventSourceImpl?: typeof EventSource;
  onEvent(p: SampleEventPayload): void;
  onStatus(s: LiveStatus): void;
  backoff?: LiveBackoff;
}

export interface LiveClient { start(): void; stop(): void; readonly invalid: number }

export const DEFAULT_BACKOFF: LiveBackoff = { baseMs: 1000, maxMs: 30_000, jitter: (n) => n / 2 + Math.random() * (n / 2) };

/**
 * SSE istemcisi. Tarayicinin kendi EventSource yeniden baglanmasi YERINE bilinen bir ustel geri cekilme kullanilir:
 * kopma -> akis kapatilir, `down`, gecikme = jitter(min(max, base * 2^deneme)); `ready` -> `live` ve geri cekilme SIFIRLANIR.
 * `closed` olayi (oturum bitti/iptal) -> `closed`, yeniden baglanma YOK (ust katman /me ile oturumu dogrular).
 * Gelen `sample` verisi zod ile dogrulanir; gecersiz olay yok sayilir ve `invalid` sayaci artar (cokmez).
 */
export function createLiveClient(opts: LiveClientOptions): LiveClient {
  const ES = opts.EventSourceImpl ?? (typeof EventSource !== "undefined" ? EventSource : undefined);
  const backoff = opts.backoff ?? DEFAULT_BACKOFF;
  let es: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let running = false;
  let invalid = 0;

  const emit = (s: LiveStatus) => { if (running) opts.onStatus(s); };

  function connect() {
    if (!running || !ES) return;
    emit("connecting");
    const src = new ES(opts.url);
    es = src;
    src.addEventListener("ready", () => { if (es !== src) return; attempt = 0; emit("live"); });
    src.addEventListener("sample", (e) => {
      if (es !== src || !running) return;
      try {
        const parsed = SampleEventPayloadSchema.safeParse(JSON.parse((e as MessageEvent<string>).data));
        if (parsed.success) opts.onEvent(parsed.data); else invalid++;
      } catch { invalid++; }
    });
    src.addEventListener("closed", () => { if (es !== src) return; src.close(); es = null; emit("closed"); });
    src.addEventListener("error", () => {
      if (es !== src) return;
      src.close(); es = null;
      emit("down");
      const delay = backoff.jitter(Math.min(backoff.maxMs, backoff.baseMs * 2 ** attempt));
      attempt++;
      timer = setTimeout(() => { timer = null; connect(); }, delay);
    });
  }

  return {
    start() { if (running) return; running = true; attempt = 0; connect(); },
    stop() {
      running = false;
      if (timer) { clearTimeout(timer); timer = null; }
      if (es) { es.close(); es = null; }
    },
    get invalid() { return invalid; },
  };
}

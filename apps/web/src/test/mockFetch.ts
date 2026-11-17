import { vi } from "vitest";

export interface MockCall { url: string; method: string; body: unknown; init: RequestInit }
type Handler = (call: MockCall) => { status: number; body?: unknown; headers?: Record<string, string> } | Promise<{ status: number; body?: unknown }>;

/**
 * Bilesen/birim testleri icin `fetch` yer tutucusu (E2E testlerinde KULLANILMAZ: orada gercek backend vardir).
 * routes anahtari "METOD /yol" (sorgu dizesi yok sayilir). Eslesmeyen istek testi KIRAR (sessiz 404 yok).
 */
export function mockFetch(routes: Record<string, Handler>): { calls: MockCall[]; fn: ReturnType<typeof vi.fn> } {
  const calls: MockCall[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    const key = `${method} ${url.split("?")[0]}`;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const call: MockCall = { url, method, body, init };
    calls.push(call);
    const h = routes[key];
    if (!h) throw new Error(`mockFetch: eslesmeyen istek ${key}`);
    const r = await h(call);
    const json = r.body === undefined ? null : JSON.stringify(r.body);
    return new Response(r.status === 204 ? null : json, { status: r.status, headers: { "content-type": "application/json", ...(("headers" in r ? r.headers : undefined) ?? {}) } });
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn };
}

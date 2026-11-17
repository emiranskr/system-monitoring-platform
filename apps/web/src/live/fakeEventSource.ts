/** Test yardimcisi: tarayici EventSource'unun kontrol edilebilir taklidi (E2E testlerinde GERCEK EventSource kullanilir). */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  private listeners = new Map<string, Set<(e: MessageEvent | Event) => void>>();

  constructor(url: string | URL) {
    this.url = String(url);
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: (e: MessageEvent | Event) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e: MessageEvent | Event) => void): void { this.listeners.get(type)?.delete(fn); }
  close(): void { this.closed = true; }

  /** Sunucudan olay geldi (kapali akis olay almaz, gercek EventSource gibi). */
  emit(type: string, data?: unknown): void {
    if (this.closed) return;
    const ev = data === undefined ? new Event(type) : new MessageEvent(type, { data: typeof data === "string" ? data : JSON.stringify(data) });
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }

  static reset(): void { FakeEventSource.instances = []; }
  static get last(): FakeEventSource { return FakeEventSource.instances[FakeEventSource.instances.length - 1]!; }
}

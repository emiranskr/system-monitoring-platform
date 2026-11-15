export interface SampleEvent {
  orgId: string;
  deviceId: string;
  /** Olaydaki en yeni ornegin zamani (ISO). */
  t: string;
  values: Record<string, number | null>;
}

declare module "fastify" {
  interface FastifyInstance { sampleBus: SampleBus }
}

/**
 * Surec-ici olay yolu: ingest COMMIT sonrasi yayinlar, SSE akislari dinler. YALNIZCA TEK API ORNEGI icin yeterlidir:
 * birden cok API ornegi calistirilirsa bir ornege gelen ingest'in olayi digerlerindeki akislara ULASMAZ (harici kuyruk
 * veya Postgres LISTEN/NOTIFY gerekir). MVP tek surectir (proposal §4); bu sinir bilincli bir kisittir.
 *
 * Ingest'i ASLA bozmaz: abone hatalari yutulur, abone yoksa hicbir is yapilmaz.
 */
export class SampleBus {
  private subs = new Map<string, Set<(e: SampleEvent) => void>>();
  private count = 0;

  get size(): number { return this.count; }

  hasSubscribers(orgId: string): boolean { return (this.subs.get(orgId)?.size ?? 0) > 0; }

  subscribe(orgId: string, fn: (e: SampleEvent) => void): () => void {
    let set = this.subs.get(orgId);
    if (!set) this.subs.set(orgId, (set = new Set()));
    set.add(fn);
    this.count++;
    return () => {
      if (!set.delete(fn)) return;
      this.count--;
      if (set.size === 0) this.subs.delete(orgId);
    };
  }

  publish(ev: SampleEvent): void {
    const set = this.subs.get(ev.orgId);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(ev); } catch { /* bir abonenin hatasi digerlerini ve ingest'i etkilemez */ }
    }
  }
}

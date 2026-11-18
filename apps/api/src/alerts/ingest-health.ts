/**
 * "Ingest saglikli" devre kesicisi (N6): veritabani veya ingest sagliksizken cihazlar sahte olarak cevrimdisi gorunur;
 * bu durumda cevrimdisi alarmlari BASTIRILIR. Saglik geri geldikten sonra da `graceMs` boyunca bastirma surer
 * (agent'lar jitter'li yeniden baglanir; sahte alarm firtinasi olmaz).
 */
export class IngestHealth {
  private lastUnhealthy: Date | null = null;
  constructor(private readonly graceMs: number) {}

  /** Ingest 5xx / veritabani hatasi / saglik sondasi basarisizligi bildirir. */
  recordFailure(now: Date): void { this.lastUnhealthy = now; }

  isHealthy(now: Date): boolean {
    return this.lastUnhealthy === null || now.getTime() - this.lastUnhealthy.getTime() >= this.graceMs;
  }
}

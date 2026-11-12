import pg from "pg";

export interface PoolOptions {
  max?: number;
  connectionTimeoutMs?: number;
  statementTimeoutMs?: number;
  idleInTransactionMs?: number;
}

/**
 * DB havuzu (inceleme I-3). Varsayilan node-postgres davranisi tehlikelidir:
 *  - "error" dinleyicisi yoksa bosta bir istemcinin hatasi (DB yeniden baslatma/failover) yakalanmamis istisnadir ve sureci cokertir;
 *  - zaman asimi yoksa takilan bir DB'de istekler sonsuza dek kuyrukta bekler, acik islemler kilit tutar.
 */
export function createPool(url: string, onError: (e: Error) => void, o: PoolOptions = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString: url,
    application_name: "sysmon-api",
    max: o.max ?? 20,
    connectionTimeoutMillis: o.connectionTimeoutMs ?? 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: o.statementTimeoutMs ?? 15_000,
    idle_in_transaction_session_timeout: o.idleInTransactionMs ?? 15_000,
  });
  pool.on("error", (e) => {
    try { onError(e); } catch { /* bildirim hatasi sureci dusurmemeli */ }
  });
  return pool;
}

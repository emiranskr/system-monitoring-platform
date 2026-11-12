import type pg from "pg";

/**
 * Havuzdan odunc alinan istemciyi guvenli kullanir. node-postgres'te odunc alinmis ve o an sorgu calistirmayan (ornegin acik
 * bir islemde) bir istemcinin baglantisi sunucu tarafinda kapanirsa istemci "error" olayi yayar; DINLEYICI YOKSA bu
 * yakalanmamis istisnadir ve SURECI COKERTIR (inceleme I-3). Odunc alma sirasinda dinleyici takilir; baglanti bozulduysa
 * istemci havuza geri verilmeden atilir, siradaki sorgu ise normal bir hata olarak yansir.
 */
const broken = new WeakMap<pg.PoolClient, { err?: Error; listener: (e: Error) => void }>();

export async function connectGuarded(pool: pg.Pool): Promise<pg.PoolClient> {
  const c = await pool.connect();
  const state: { err?: Error; listener: (e: Error) => void } = { listener: (e) => { state.err = e; } };
  broken.set(c, state);
  c.on("error", state.listener);
  return c;
}

export function releaseGuarded(c: pg.PoolClient): void {
  const s = broken.get(c);
  broken.delete(c);
  if (s) c.removeListener("error", s.listener);
  c.release(s?.err); // Error verilirse istemci havuzdan atilir
}

export async function withClient<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await connectGuarded(pool);
  try {
    return await fn(c);
  } finally {
    releaseGuarded(c);
  }
}

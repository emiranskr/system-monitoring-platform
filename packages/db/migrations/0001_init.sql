-- M2 B1: cekirdek sema. TimescaleDB (TSL: sikistirma + continuous aggregate; ADR 0001/D7).
-- Cok-organizasyona hazir (org_id her tabloda, bilesik FK); RLS ertelendi (D11).
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE orgs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE devices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs (id),
  name         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at   timestamptz,
  -- Bilesik FK'lar baska organizasyona baglanan alt kayitlari yapisal olarak imkansiz kilar.
  UNIQUE (org_id, id)
);

-- Token'in kendisi ASLA saklanmaz: yalnizca SHA-256 ozeti. Ham token yuksek entropili (>=128 bit) oldugu icin
-- yavas parola hash'i gerekmez; ozet uzerinden esitlik aramasi yeterlidir.
CREATE TABLE device_tokens (
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  org_id     uuid NOT NULL,
  device_id  uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  FOREIGN KEY (org_id, device_id) REFERENCES devices (org_id, id)
);
CREATE INDEX device_tokens_device_idx ON device_tokens (device_id);

-- (cihaz, spool_epoch) basina son islenen seq: yinelenen batch idempotent, eski epoch'lar kendi sayaciyla devam eder.
CREATE TABLE device_ingest_state (
  org_id      uuid NOT NULL,
  device_id   uuid NOT NULL,
  spool_epoch uuid NOT NULL,
  last_seq    bigint NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, spool_epoch),
  FOREIGN KEY (org_id, device_id) REFERENCES devices (org_id, id)
);

-- Dar tablo: bir satir = bir (cihaz, metrik, zaman). value NULL = "kullanilamiyor".
CREATE TABLE metric_samples (
  ts        timestamptz NOT NULL,
  org_id    uuid NOT NULL,
  device_id uuid NOT NULL,
  metric    text NOT NULL,
  value     double precision,
  -- Hypertable benzersiz kisiti bolumleme sutununu (ts) icermelidir. Yinelenen insert: ON CONFLICT DO NOTHING.
  PRIMARY KEY (device_id, metric, ts),
  FOREIGN KEY (org_id, device_id) REFERENCES devices (org_id, id)
);
SELECT create_hypertable('metric_samples', 'ts', chunk_time_interval => INTERVAL '1 day');

ALTER TABLE metric_samples SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'device_id, metric',
  timescaledb.compress_orderby = 'ts DESC'
);
SELECT add_compression_policy('metric_samples', compress_after => INTERVAL '2 days');
SELECT add_retention_policy('metric_samples', drop_after => INTERVAL '3 days'); -- ham veri 3 gun (D7)

-- 1 dakikalik continuous aggregate (D7: 30 gun). Elle yenilenebilir; politika yalnizca yakin pencereyi yeniler,
-- boylece ham verinin 3. gunde dusmesi gecmis agregayi bozmaz.
CREATE MATERIALIZED VIEW metric_1m WITH (timescaledb.continuous) AS
SELECT time_bucket(INTERVAL '1 minute', ts) AS bucket,
       org_id, device_id, metric,
       avg(value) AS avg_value,
       min(value) AS min_value,
       max(value) AS max_value,
       count(value) AS n
FROM metric_samples
GROUP BY 1, 2, 3, 4
WITH NO DATA;
SELECT add_continuous_aggregate_policy('metric_1m',
  start_offset => INTERVAL '2 days', end_offset => INTERVAL '1 minute', schedule_interval => INTERVAL '1 minute');
SELECT add_retention_policy('metric_1m', drop_after => INTERVAL '30 days');

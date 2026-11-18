-- M5: uyari kurallari, durum, olaylar (incidents), bildirim kanallari ve KALICI bildirim kuyrugu.
-- Yalniz YENI tablolar. Her tabloda org_id vardir; alt tablolar bilesik FK (org_id, ...) kullanir: baska organizasyona baglanti yapisal olarak imkansiz.
-- Silme YUMUSAKTIR (deleted_at): gecmis olaylarin kural/kanal referanslari bozulmaz.

-- Kanal yapilandirmasi (webhook URL'si, SMTP sunucusu/parolasi, alicilar) SIR sayilir: tamami AES-256-GCM ile sifreli saklanir
-- (nonce(12) || etiket(16) || sifreli metin). API'ye YALNIZ `summary` (sir icermeyen ozet) doner.
CREATE TABLE notification_channels (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES orgs (id),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  type       text NOT NULL CHECK (type IN ('webhook', 'email')),
  config_enc bytea NOT NULL CHECK (octet_length(config_enc) >= 29),
  summary    jsonb NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (org_id, id)
);

CREATE TABLE alert_rules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES orgs (id),
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  -- Metrik adi ve operator uygulama katmaninda SABIT izin listesiyle dogrulanir; sorgularda YALNIZ parametre olarak kullanilir.
  metric           text NOT NULL CHECK (length(metric) <= 64),
  agg              text NOT NULL CHECK (agg IN ('avg', 'max')),
  window_seconds   integer NOT NULL CHECK (window_seconds BETWEEN 15 AND 3600),
  operator         text NOT NULL CHECK (operator IN ('>', '>=', '<', '<=')),
  threshold        double precision NOT NULL,
  hysteresis       double precision NOT NULL DEFAULT 0 CHECK (hysteresis >= 0),
  for_seconds      integer NOT NULL CHECK (for_seconds BETWEEN 0 AND 86400),
  severity         text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  scope_device_ids uuid[],                          -- NULL = organizasyondaki tum cihazlar
  channel_ids      uuid[] NOT NULL DEFAULT '{}',
  builtin          text CHECK (builtin IN ('offline', 'disk_full', 'cpu_high', 'mem_high')),
  enabled          boolean NOT NULL DEFAULT true,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  UNIQUE (org_id, id)
);
CREATE UNIQUE INDEX alert_rules_builtin_idx ON alert_rules (org_id, builtin) WHERE builtin IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX alert_rules_org_idx ON alert_rules (org_id) WHERE deleted_at IS NULL;

-- Kural x cihaz basina durum makinesi durumu (OK/PENDING/FIRING). RESOLVED, olayin (incident) kapanmasidir.
CREATE TABLE alert_state (
  rule_id       uuid NOT NULL,
  device_id     uuid NOT NULL,
  org_id        uuid NOT NULL,
  state         text NOT NULL CHECK (state IN ('ok', 'pending', 'firing')),
  pending_since timestamptz,
  last_value    double precision,
  updated_at    timestamptz NOT NULL,
  PRIMARY KEY (rule_id, device_id),
  FOREIGN KEY (org_id, rule_id) REFERENCES alert_rules (org_id, id),
  FOREIGN KEY (org_id, device_id) REFERENCES devices (org_id, id)
);

-- Olay: bir kuralin bir cihazda tetiklenmesinden cozulmesine kadar. Kural/cihaz adi anlik goruntu olarak saklanir.
CREATE TABLE incidents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs (id),
  rule_id     uuid NOT NULL,
  device_id   uuid NOT NULL,
  rule_name   text NOT NULL,
  device_name text NOT NULL,
  metric      text NOT NULL,
  severity    text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  opened_at   timestamptz NOT NULL,
  resolved_at timestamptz,
  last_value  double precision,
  peak_value  double precision,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, rule_id) REFERENCES alert_rules (org_id, id),
  FOREIGN KEY (org_id, device_id) REFERENCES devices (org_id, id)
);
-- Bir kural/cihaz icin ayni anda en cok BIR acik olay.
CREATE UNIQUE INDEX incidents_open_idx ON incidents (rule_id, device_id) WHERE resolved_at IS NULL;
CREATE INDEX incidents_org_time_idx ON incidents (org_id, opened_at DESC);

-- KALICI bildirim kuyrugu: API yeniden baslarsa bekleyen bildirimler kaybolmaz. (incident_id, kind, channel_id) TEKIL:
-- ayni olay icin ayni kanala mukerrer bildirim satiri olusamaz (yeniden deneme AYNI satiri gunceller).
CREATE TABLE notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES orgs (id),
  incident_id     uuid,
  channel_id      uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('firing', 'resolved', 'test')),
  status          text NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  lease_until     timestamptz,                       -- 'sending' kirasi: calisan cokerse sure dolunca yeniden alinir
  last_error      text,
  payload         jsonb NOT NULL,                    -- sir ICERMEZ (kural/cihaz adi, deger, zaman)
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  UNIQUE (incident_id, kind, channel_id),
  FOREIGN KEY (org_id, incident_id) REFERENCES incidents (org_id, id),
  FOREIGN KEY (org_id, channel_id) REFERENCES notification_channels (org_id, id)
);
CREATE INDEX notifications_due_idx ON notifications (next_attempt_at) WHERE status IN ('pending', 'sending');

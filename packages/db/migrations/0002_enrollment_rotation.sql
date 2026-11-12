-- M2 B2/B4: enrollment, kimlik bilgisi rotation'i, denetim olaylari.

-- Yonetici tarafindan uretilen TEK KULLANIMLIK enrollment token'lari (varsayilan 1 saat). Yalnizca SHA-256 ozeti saklanir.
CREATE TABLE enrollment_tokens (
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  org_id     uuid NOT NULL REFERENCES orgs (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  device_id  uuid REFERENCES devices (id)
);

ALTER TABLE devices
  ADD COLUMN machine_guid_hash bytea,
  ADD COLUMN device_info jsonb,
  ADD COLUMN compromised_at timestamptz;

-- Kayip yanit sonrasi yeniden deneme penceresi (10 dk): ayni enroll_id + MachineGuid ayni credential'i alir.
-- Credential bu sure boyunca AES-GCM ile SIFRELI tutulur, sonra NULL'lanir (sifreli kopya silinir).
CREATE TABLE enrollments (
  enroll_id         uuid PRIMARY KEY,
  machine_guid_hash bytea NOT NULL,
  org_id            uuid NOT NULL,
  device_id         uuid NOT NULL,
  credential_enc    bytea,
  created_at        timestamptz NOT NULL DEFAULT now(),
  retry_expires_at  timestamptz NOT NULL,
  FOREIGN KEY (org_id, device_id) REFERENCES devices (org_id, id)
);

-- Rotation: eski satir yeni satirin ozetini (superseded_by) ve ust uste binme bitisini tutar.
-- Yeni credential, ilk kullanilana kadar sifreli saklanir (ayni rotation_id ile yeniden denemede ayni token doner).
ALTER TABLE device_tokens
  ADD COLUMN first_used_at timestamptz,
  ADD COLUMN superseded_by bytea REFERENCES device_tokens (token_hash),
  ADD COLUMN overlap_expires_at timestamptz,
  ADD COLUMN rotation_id uuid,
  ADD COLUMN credential_enc bytea;

CREATE TABLE audit_events (
  id        bigserial PRIMARY KEY,
  ts        timestamptz NOT NULL DEFAULT now(),
  org_id    uuid,
  device_id uuid,
  kind      text NOT NULL,
  detail    jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_events_device_idx ON audit_events (device_id, ts);

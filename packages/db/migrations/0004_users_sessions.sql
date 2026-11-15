-- M3a: panel kullanicilari, sunucu tarafi oturumlar, ilk kurulum token'lari.
-- Yalniz YENI tablolar; mevcut tablolara dokunulmaz.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs (id),
  email         text NOT NULL,
  password_hash text NOT NULL,                       -- argon2id kodlu ozet (parola ASLA saklanmaz)
  role          text NOT NULL CHECK (role IN ('owner', 'admin', 'viewer')),
  disabled_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)                                -- bilesik FK hedefi
);
-- E-posta kuresel ve buyuk/kucuk harf duyarsiz tekil (giris org bilinmeden e-postayla aranir).
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

-- Oturum kimligi yuksek entropili (256 bit) rastgeledir; DB'de yalniz SHA-256 ozeti saklanir (cerez calinsa bile DB sizintisi oturum vermez).
CREATE TABLE sessions (
  id_hash      bytea PRIMARY KEY CHECK (octet_length(id_hash) = 32),
  org_id       uuid NOT NULL,
  user_id      uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,                 -- mutlak sinir
  ip           inet,
  ua           text,
  FOREIGN KEY (org_id, user_id) REFERENCES users (org_id, id) ON DELETE CASCADE
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- Ilk kurulum (owner olusturma) icin tek kullanimlik token; yalniz ozeti saklanir.
CREATE TABLE setup_tokens (
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at    timestamptz
);

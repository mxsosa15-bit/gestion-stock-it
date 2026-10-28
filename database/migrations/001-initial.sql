CREATE SCHEMA IF NOT EXISTS gestion_it;

CREATE TABLE IF NOT EXISTS gestion_it.inventory_snapshot (
  singleton_id boolean PRIMARY KEY DEFAULT true CHECK (singleton_id),
  revision bigint NOT NULL DEFAULT 0,
  payload jsonb NOT NULL DEFAULT '{
    "pisos": [],
    "areas": [],
    "stock": [],
    "puestos": [],
    "equiposRed": [],
    "componentesRetirados": [],
    "historial": []
  }'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO gestion_it.inventory_snapshot (singleton_id)
VALUES (true)
ON CONFLICT (singleton_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS gestion_it.app_users (
  id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'operator' CHECK (role IN ('admin', 'operator')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gestion_it.sessions (
  sid varchar NOT NULL PRIMARY KEY,
  sess json NOT NULL,
  expire timestamp(6) NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_expire_idx ON gestion_it.sessions (expire);

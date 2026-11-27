CREATE TABLE IF NOT EXISTS gestion_it.inventory_stock_shipments (
  idempotency_key uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES gestion_it.app_users (id) ON DELETE RESTRICT,
  request_fingerprint char(64) NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  insumo_id text NOT NULL,
  destino_sede_id uuid NOT NULL REFERENCES gestion_it.sedes (id) ON DELETE RESTRICT,
  cantidad integer NOT NULL CHECK (cantidad > 0),
  motivo text NOT NULL CHECK (length(btrim(motivo)) BETWEEN 1 AND 500),
  movement_id text NOT NULL UNIQUE,
  processed_revision bigint NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inventory_stock_shipments_actor_created_idx
  ON gestion_it.inventory_stock_shipments (actor_id, created_at DESC);

BEGIN;

ALTER TABLE gestion_it.ticket_workshop_transfers
  ADD COLUMN IF NOT EXISTS devuelto_por uuid NULL
    REFERENCES gestion_it.app_users (id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS devuelto_at timestamptz NULL;

COMMIT;

BEGIN;

ALTER TABLE gestion_it.tickets
  ADD COLUMN IF NOT EXISTS fecha_resolucion timestamptz NULL;

COMMIT;

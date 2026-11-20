BEGIN;

ALTER TABLE gestion_it.tickets
  ADD COLUMN IF NOT EXISTS area_id uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'tickets_area_id_fkey'
      AND conrelid = 'gestion_it.tickets'::regclass
  ) THEN
    ALTER TABLE gestion_it.tickets
      ADD CONSTRAINT tickets_area_id_fkey
      FOREIGN KEY (area_id)
      REFERENCES gestion_it.areas (id)
      ON DELETE SET NULL;
  END IF;
END;
$$;

UPDATE gestion_it.tickets AS ticket
SET area_id = app_user.area_id
FROM gestion_it.app_users AS app_user
WHERE ticket.usuario_id = app_user.id
  AND ticket.area_id IS NULL
  AND app_user.area_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS tickets_area_id_idx
  ON gestion_it.tickets (area_id, fecha_creacion DESC, id DESC);

COMMIT;

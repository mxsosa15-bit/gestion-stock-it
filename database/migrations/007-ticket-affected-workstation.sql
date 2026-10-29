BEGIN;

ALTER TABLE gestion_it.tickets
  ADD COLUMN IF NOT EXISTS puesto_afectado_id text NULL,
  ADD COLUMN IF NOT EXISTS nombre_afectado text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'tickets_affected_workstation_valid_check'
      AND conrelid = 'gestion_it.tickets'::regclass
  ) THEN
    ALTER TABLE gestion_it.tickets
      ADD CONSTRAINT tickets_affected_workstation_valid_check
      CHECK (
        (puesto_afectado_id IS NULL AND nombre_afectado IS NULL)
        OR (
          NULLIF(btrim(puesto_afectado_id), '') IS NOT NULL
          AND NULLIF(btrim(nombre_afectado), '') IS NOT NULL
        )
      );
  END IF;
END;
$$;

COMMIT;

BEGIN;

ALTER TABLE gestion_it.operator_tasks
  ADD COLUMN IF NOT EXISTS performed_at timestamptz,
  ADD COLUMN IF NOT EXISTS area_id uuid NULL,
  ADD COLUMN IF NOT EXISTS related_asset_type text NULL,
  ADD COLUMN IF NOT EXISTS related_asset_id text NULL,
  ADD COLUMN IF NOT EXISTS observations text NOT NULL DEFAULT '';

UPDATE gestion_it.operator_tasks
SET performed_at = created_at
WHERE performed_at IS NULL;

ALTER TABLE gestion_it.operator_tasks
  ALTER COLUMN performed_at SET DEFAULT now(),
  ALTER COLUMN performed_at SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'operator_tasks_area_id_fkey'
      AND conrelid = 'gestion_it.operator_tasks'::regclass
  ) THEN
    ALTER TABLE gestion_it.operator_tasks
      ADD CONSTRAINT operator_tasks_area_id_fkey
      FOREIGN KEY (area_id)
      REFERENCES gestion_it.areas (id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'operator_tasks_related_asset_pair_check'
      AND conrelid = 'gestion_it.operator_tasks'::regclass
  ) THEN
    ALTER TABLE gestion_it.operator_tasks
      ADD CONSTRAINT operator_tasks_related_asset_pair_check
      CHECK (
        (related_asset_type IS NULL AND related_asset_id IS NULL)
        OR (
          related_asset_type IN ('PUESTO', 'COMPONENTE', 'EQUIPO_RED', 'PATRIMONIAL')
          AND NULLIF(btrim(related_asset_id), '') IS NOT NULL
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'operator_tasks_observations_length_check'
      AND conrelid = 'gestion_it.operator_tasks'::regclass
  ) THEN
    ALTER TABLE gestion_it.operator_tasks
      ADD CONSTRAINT operator_tasks_observations_length_check
      CHECK (length(observations) <= 5000);
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS operator_tasks_area_performed_idx
  ON gestion_it.operator_tasks (area_id, performed_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS operator_tasks_operator_performed_idx
  ON gestion_it.operator_tasks (operator_id, performed_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS operator_tasks_sede_performed_idx
  ON gestion_it.operator_tasks (sede_id, performed_at DESC, id DESC);

COMMIT;

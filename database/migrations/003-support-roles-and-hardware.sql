BEGIN;

DO $$
DECLARE
  role_check record;
BEGIN
  FOR role_check IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'gestion_it.app_users'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%role%'
  LOOP
    EXECUTE format('ALTER TABLE gestion_it.app_users DROP CONSTRAINT %I', role_check.conname);
  END LOOP;
END;
$$;

ALTER TABLE gestion_it.app_users
  ADD CONSTRAINT app_users_role_valid_check
  CHECK (role IN ('admin', 'operator', 'solicitante', 'dashboard'));

ALTER TABLE gestion_it.areas
  DROP CONSTRAINT IF EXISTS areas_nombre_key;

ALTER TABLE gestion_it.areas
  ADD COLUMN IF NOT EXISTS inventory_area_id text NULL UNIQUE;

ALTER TABLE gestion_it.areas
  ADD COLUMN IF NOT EXISTS activo boolean NOT NULL DEFAULT true;

INSERT INTO gestion_it.areas (nombre, inventory_area_id, activo)
SELECT btrim(area->>'nombre'), area->>'id', true
FROM gestion_it.inventory_snapshot AS snapshot
CROSS JOIN LATERAL jsonb_array_elements(snapshot.payload->'areas') AS area
WHERE snapshot.singleton_id = true
  AND btrim(COALESCE(area->>'nombre', '')) <> ''
  AND COALESCE(area->>'id', '') <> ''
ON CONFLICT (inventory_area_id) DO UPDATE
SET nombre = EXCLUDED.nombre, activo = true;

ALTER TABLE gestion_it.tickets
  ADD COLUMN IF NOT EXISTS solucion text NULL;

DO $$
DECLARE
  state_check record;
BEGIN
  FOR state_check IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'gestion_it.tickets'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%estado%'
  LOOP
    EXECUTE format('ALTER TABLE gestion_it.tickets DROP CONSTRAINT %I', state_check.conname);
  END LOOP;
END;
$$;

UPDATE gestion_it.tickets
SET estado = 'Terminado'
WHERE estado = 'Resuelto';

ALTER TABLE gestion_it.tickets
  ADD CONSTRAINT tickets_estado_valid_check
  CHECK (estado IN ('Abierto', 'En proceso', 'Terminado'));

CREATE TABLE IF NOT EXISTS gestion_it.hardware_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo text NOT NULL CHECK (tipo IN ('MONITOR', 'IMPRESORA', 'SCANNER', 'TECLADO', 'MOUSE', 'OTRO')),
  marca text NOT NULL,
  modelo text NULL,
  especificacion text NULL,
  numero_serie varchar(200) NOT NULL UNIQUE,
  numero_patrimonio varchar(100) NULL UNIQUE,
  fecha_registro timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hardware_assets_fecha_registro_idx
  ON gestion_it.hardware_assets (fecha_registro DESC);

CREATE UNIQUE INDEX IF NOT EXISTS hardware_assets_numero_serie_ci_idx
  ON gestion_it.hardware_assets (lower(numero_serie));

CREATE UNIQUE INDEX IF NOT EXISTS hardware_assets_numero_patrimonio_ci_idx
  ON gestion_it.hardware_assets (lower(numero_patrimonio))
  WHERE numero_patrimonio IS NOT NULL;

COMMIT;

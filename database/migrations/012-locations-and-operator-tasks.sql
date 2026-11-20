BEGIN;

CREATE TABLE IF NOT EXISTS gestion_it.sedes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre text NOT NULL,
  tipo text NOT NULL CHECK (tipo IN ('CENTRAL', 'DELEGACION')),
  departamento text NOT NULL DEFAULT '',
  localidad text NOT NULL DEFAULT '',
  direccion text NOT NULL DEFAULT '',
  activa boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS sedes_nombre_ci_idx
  ON gestion_it.sedes (lower(nombre));

INSERT INTO gestion_it.sedes (id, nombre, tipo)
VALUES ('00000000-0000-4000-8000-000000000001', 'Casa Central', 'CENTRAL')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE gestion_it.areas
  ADD COLUMN IF NOT EXISTS sede_id uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'areas_sede_id_fkey'
      AND conrelid = 'gestion_it.areas'::regclass
  ) THEN
    ALTER TABLE gestion_it.areas
      ADD CONSTRAINT areas_sede_id_fkey
      FOREIGN KEY (sede_id)
      REFERENCES gestion_it.sedes (id)
      ON DELETE RESTRICT;
  END IF;
END;
$$;

UPDATE gestion_it.areas
SET sede_id = '00000000-0000-4000-8000-000000000001'
WHERE sede_id IS NULL;

ALTER TABLE gestion_it.areas
  ALTER COLUMN sede_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS areas_sede_id_idx
  ON gestion_it.areas (sede_id);

ALTER TABLE gestion_it.tickets
  ADD COLUMN IF NOT EXISTS sede_id uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'tickets_sede_id_fkey'
      AND conrelid = 'gestion_it.tickets'::regclass
  ) THEN
    ALTER TABLE gestion_it.tickets
      ADD CONSTRAINT tickets_sede_id_fkey
      FOREIGN KEY (sede_id)
      REFERENCES gestion_it.sedes (id)
      ON DELETE RESTRICT;
  END IF;
END;
$$;

UPDATE gestion_it.tickets AS ticket
SET sede_id = COALESCE(area.sede_id, '00000000-0000-4000-8000-000000000001')
FROM gestion_it.app_users AS app_user
LEFT JOIN gestion_it.areas AS area ON area.id = app_user.area_id
WHERE ticket.usuario_id = app_user.id
  AND ticket.sede_id IS NULL;

ALTER TABLE gestion_it.tickets
  ALTER COLUMN sede_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS tickets_sede_created_idx
  ON gestion_it.tickets (sede_id, fecha_creacion DESC, id DESC);

ALTER TABLE gestion_it.hardware_assets
  ADD COLUMN IF NOT EXISTS sede_id uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'hardware_assets_sede_id_fkey'
      AND conrelid = 'gestion_it.hardware_assets'::regclass
  ) THEN
    ALTER TABLE gestion_it.hardware_assets
      ADD CONSTRAINT hardware_assets_sede_id_fkey
      FOREIGN KEY (sede_id)
      REFERENCES gestion_it.sedes (id)
      ON DELETE RESTRICT;
  END IF;
END;
$$;

UPDATE gestion_it.hardware_assets
SET sede_id = '00000000-0000-4000-8000-000000000001'
WHERE sede_id IS NULL;

ALTER TABLE gestion_it.hardware_assets
  ALTER COLUMN sede_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS hardware_assets_sede_id_idx
  ON gestion_it.hardware_assets (sede_id);

UPDATE gestion_it.inventory_snapshot AS snapshot
SET payload = jsonb_set(
  jsonb_set(
    snapshot.payload,
    '{pisos}',
    COALESCE(
      (
        SELECT jsonb_agg(
          CASE
            WHEN piso ? 'sedeId' THEN piso
            ELSE piso || jsonb_build_object('sedeId', '00000000-0000-4000-8000-000000000001')
          END
          ORDER BY ordinalidad
        )
        FROM jsonb_array_elements(COALESCE(snapshot.payload->'pisos', '[]'::jsonb))
          WITH ORDINALITY AS pisos(piso, ordinalidad)
      ),
      '[]'::jsonb
    ),
    true
  ),
  '{stock}',
  COALESCE(
    (
      SELECT jsonb_agg(
        CASE
          WHEN insumo ? 'sedeId' THEN insumo
          ELSE insumo || jsonb_build_object('sedeId', '00000000-0000-4000-8000-000000000001')
        END
        ORDER BY ordinalidad
      )
      FROM jsonb_array_elements(COALESCE(snapshot.payload->'stock', '[]'::jsonb))
        WITH ORDINALITY AS insumos(insumo, ordinalidad)
    ),
    '[]'::jsonb
  ),
  true
),
revision = snapshot.revision + 1,
updated_at = now()
WHERE snapshot.singleton_id = true
  AND (
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(snapshot.payload->'pisos', '[]'::jsonb)) AS items(piso)
      WHERE NOT (items.piso ? 'sedeId')
    )
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(snapshot.payload->'stock', '[]'::jsonb)) AS items(insumo)
      WHERE NOT (items.insumo ? 'sedeId')
    )
  );

CREATE TABLE IF NOT EXISTS gestion_it.operator_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sede_id uuid NOT NULL REFERENCES gestion_it.sedes (id) ON DELETE RESTRICT,
  operator_id uuid NOT NULL REFERENCES gestion_it.app_users (id) ON DELETE RESTRICT,
  tipo text NOT NULL CHECK (
    tipo IN ('Mantenimiento', 'Instalación', 'Configuración', 'Relevamiento', 'Otro')
  ),
  titulo text NOT NULL CHECK (length(btrim(titulo)) BETWEEN 1 AND 200),
  descripcion text NOT NULL CHECK (length(btrim(descripcion)) BETWEEN 1 AND 5000),
  duracion_minutos integer NULL CHECK (duracion_minutos BETWEEN 0 AND 1440),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS operator_tasks_sede_created_idx
  ON gestion_it.operator_tasks (sede_id, created_at DESC, id DESC);

COMMIT;

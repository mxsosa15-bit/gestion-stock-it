BEGIN;

CREATE TABLE IF NOT EXISTS gestion_it.areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre text NOT NULL UNIQUE
);

ALTER TABLE gestion_it.app_users
  ADD COLUMN IF NOT EXISTS area_id uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'app_users_area_id_fkey'
      AND conrelid = 'gestion_it.app_users'::regclass
  ) THEN
    ALTER TABLE gestion_it.app_users
      ADD CONSTRAINT app_users_area_id_fkey
      FOREIGN KEY (area_id)
      REFERENCES gestion_it.areas (id)
      ON DELETE SET NULL;
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS gestion_it.tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  titulo text NOT NULL,
  descripcion text NOT NULL,
  estado text NOT NULL DEFAULT 'Abierto'
    CHECK (estado IN ('Abierto', 'En curso', 'Resuelto')),
  fecha_creacion timestamptz NOT NULL DEFAULT now(),
  usuario_id uuid NOT NULL
    REFERENCES gestion_it.app_users (id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS tickets_fecha_creacion_idx
  ON gestion_it.tickets (fecha_creacion ASC, id ASC);

CREATE INDEX IF NOT EXISTS tickets_usuario_id_idx
  ON gestion_it.tickets (usuario_id);

CREATE TABLE IF NOT EXISTS gestion_it.inventory_asset_labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo_entidad text NOT NULL,
  entidad_id text NOT NULL,
  numero_patrimonio varchar(100) NULL UNIQUE,
  UNIQUE (tipo_entidad, entidad_id)
);

COMMIT;

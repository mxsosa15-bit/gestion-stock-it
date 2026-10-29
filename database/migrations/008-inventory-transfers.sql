BEGIN;

UPDATE gestion_it.inventory_snapshot AS snapshot
SET payload = jsonb_set(
  snapshot.payload,
  '{personas}',
  COALESCE(
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', gen_random_uuid()::text,
          'nombre', btrim(puesto->>'usuarioAsignado'),
          'areaId', puesto->>'areaId',
          'puestoId', puesto->>'id'
        )
        ORDER BY btrim(puesto->>'usuarioAsignado'), puesto->>'id'
      )
      FROM jsonb_array_elements(
        COALESCE(snapshot.payload->'puestos', '[]'::jsonb)
      ) AS puesto
      WHERE NULLIF(btrim(puesto->>'usuarioAsignado'), '') IS NOT NULL
        AND NULLIF(btrim(puesto->>'id'), '') IS NOT NULL
    ),
    '[]'::jsonb
  ),
  true
),
revision = snapshot.revision + 1,
updated_at = now()
WHERE snapshot.singleton_id = true
  AND snapshot.payload->'personas' IS NULL;

CREATE TABLE IF NOT EXISTS gestion_it.inventory_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by uuid NOT NULL REFERENCES gestion_it.app_users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 1000),
  origin_area_id text NULL,
  destination_area_id text NULL,
  origin_floor_id text NULL,
  destination_floor_id text NULL
);

CREATE TABLE IF NOT EXISTS gestion_it.inventory_transfer_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id uuid NOT NULL
    REFERENCES gestion_it.inventory_transfers (id) ON DELETE RESTRICT,
  entity_type text NOT NULL
    CHECK (entity_type IN ('AREA', 'PERSONA', 'COMPONENTE', 'EQUIPO_RED')),
  entity_id text NOT NULL,
  entity_name text NOT NULL,
  origin jsonb NOT NULL,
  destination jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inventory_transfers_created_at_idx
  ON gestion_it.inventory_transfers (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS inventory_transfer_movements_entity_idx
  ON gestion_it.inventory_transfer_movements (entity_type, entity_id, created_at DESC);

CREATE INDEX IF NOT EXISTS inventory_transfer_movements_transfer_idx
  ON gestion_it.inventory_transfer_movements (transfer_id);

COMMIT;

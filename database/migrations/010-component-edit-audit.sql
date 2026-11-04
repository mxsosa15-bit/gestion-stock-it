CREATE TABLE IF NOT EXISTS gestion_it.inventory_component_edits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  component_id text NOT NULL,
  puesto_id text NOT NULL,
  changed_by uuid NOT NULL REFERENCES gestion_it.app_users (id) ON DELETE RESTRICT,
  changed_by_username text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  before_data jsonb NOT NULL,
  after_data jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS inventory_component_edits_component_idx
  ON gestion_it.inventory_component_edits (component_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS inventory_component_edits_changed_at_idx
  ON gestion_it.inventory_component_edits (changed_at DESC);

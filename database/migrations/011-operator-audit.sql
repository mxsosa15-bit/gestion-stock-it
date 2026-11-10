CREATE TABLE IF NOT EXISTS gestion_it.operator_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES gestion_it.app_users (id) ON DELETE RESTRICT,
  actor_username text NOT NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NULL,
  entity_name text NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS operator_audit_events_actor_created_idx
  ON gestion_it.operator_audit_events (actor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS operator_audit_events_created_idx
  ON gestion_it.operator_audit_events (created_at DESC);

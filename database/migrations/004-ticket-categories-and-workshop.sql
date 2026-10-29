BEGIN;

ALTER TABLE gestion_it.tickets
  ADD COLUMN IF NOT EXISTS categoria text NOT NULL DEFAULT 'Otros';

ALTER TABLE gestion_it.tickets
  DROP CONSTRAINT IF EXISTS tickets_categoria_valid_check;

ALTER TABLE gestion_it.tickets
  ADD CONSTRAINT tickets_categoria_valid_check
  CHECK (categoria IN (
    'Impresora', 'Monitor', 'Internet', 'Turnero',
    'Pantallas', 'Computadora', 'Red', 'Otros'
  ));

CREATE TABLE IF NOT EXISTS gestion_it.ticket_workshop_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES gestion_it.tickets (id) ON DELETE CASCADE,
  equipo text NOT NULL CHECK (length(btrim(equipo)) BETWEEN 1 AND 200),
  identificacion text NOT NULL CHECK (length(btrim(identificacion)) BETWEEN 1 AND 200),
  detalle text NOT NULL CHECK (length(btrim(detalle)) BETWEEN 1 AND 2000),
  estado text NOT NULL DEFAULT 'Pendiente'
    CHECK (estado IN ('Pendiente', 'Aprobado', 'Rechazado')),
  solicitado_por uuid NOT NULL REFERENCES gestion_it.app_users (id) ON DELETE RESTRICT,
  solicitado_at timestamptz NOT NULL DEFAULT now(),
  aprobado_por uuid NULL REFERENCES gestion_it.app_users (id) ON DELETE RESTRICT,
  aprobado_at timestamptz NULL,
  motivo_rechazo text NULL CHECK (motivo_rechazo IS NULL OR length(motivo_rechazo) <= 2000),
  CONSTRAINT ticket_workshop_transfers_approval_valid_check CHECK (
    (estado = 'Pendiente' AND aprobado_por IS NULL AND aprobado_at IS NULL AND motivo_rechazo IS NULL)
    OR (estado = 'Aprobado' AND aprobado_por IS NOT NULL AND aprobado_at IS NOT NULL AND motivo_rechazo IS NULL)
    OR (estado = 'Rechazado' AND aprobado_por IS NOT NULL AND aprobado_at IS NOT NULL AND motivo_rechazo IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS ticket_workshop_transfers_ticket_date_idx
  ON gestion_it.ticket_workshop_transfers (ticket_id, solicitado_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS ticket_workshop_transfers_one_pending_per_ticket_idx
  ON gestion_it.ticket_workshop_transfers (ticket_id)
  WHERE estado = 'Pendiente';

COMMIT;

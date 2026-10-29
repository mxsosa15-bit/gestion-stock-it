BEGIN;

ALTER TABLE gestion_it.ticket_workshop_transfers
  ADD COLUMN IF NOT EXISTS devuelto_por uuid NULL
    REFERENCES gestion_it.app_users (id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS devuelto_at timestamptz NULL;

DO $$
DECLARE
  transfer_check record;
BEGIN
  FOR transfer_check IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'gestion_it.ticket_workshop_transfers'::regclass
      AND contype = 'c'
      AND (
        pg_get_constraintdef(oid) LIKE '%estado%'
        OR pg_get_constraintdef(oid) LIKE '%aprobado_por%'
        OR pg_get_constraintdef(oid) LIKE '%devuelto_por%'
      )
  LOOP
    EXECUTE format(
      'ALTER TABLE gestion_it.ticket_workshop_transfers DROP CONSTRAINT %I',
      transfer_check.conname
    );
  END LOOP;
END;
$$;

UPDATE gestion_it.ticket_workshop_transfers
SET estado = 'En taller'
WHERE estado = 'Aprobado';

ALTER TABLE gestion_it.ticket_workshop_transfers
  ADD CONSTRAINT ticket_workshop_transfers_estado_valid_check
  CHECK (estado IN ('Pendiente', 'En taller', 'Devuelto', 'Rechazado')),
  ADD CONSTRAINT ticket_workshop_transfers_lifecycle_valid_check
  CHECK (
    (
      estado = 'Pendiente'
      AND aprobado_por IS NULL
      AND aprobado_at IS NULL
      AND motivo_rechazo IS NULL
      AND devuelto_por IS NULL
      AND devuelto_at IS NULL
    )
    OR (
      estado = 'En taller'
      AND aprobado_por IS NOT NULL
      AND aprobado_at IS NOT NULL
      AND motivo_rechazo IS NULL
      AND devuelto_por IS NULL
      AND devuelto_at IS NULL
    )
    OR (
      estado = 'Devuelto'
      AND aprobado_por IS NOT NULL
      AND aprobado_at IS NOT NULL
      AND motivo_rechazo IS NULL
      AND devuelto_por IS NOT NULL
      AND devuelto_at IS NOT NULL
    )
    OR (
      estado = 'Rechazado'
      AND aprobado_por IS NOT NULL
      AND aprobado_at IS NOT NULL
      AND motivo_rechazo IS NOT NULL
      AND devuelto_por IS NULL
      AND devuelto_at IS NULL
    )
  );

CREATE INDEX IF NOT EXISTS ticket_workshop_transfers_workshop_idx
  ON gestion_it.ticket_workshop_transfers (solicitado_at DESC)
  WHERE estado = 'En taller';

DROP INDEX IF EXISTS gestion_it.ticket_workshop_transfers_one_pending_per_ticket_idx;
CREATE UNIQUE INDEX IF NOT EXISTS ticket_workshop_transfers_one_active_per_ticket_idx
  ON gestion_it.ticket_workshop_transfers (ticket_id)
  WHERE estado IN ('Pendiente', 'En taller');

COMMIT;

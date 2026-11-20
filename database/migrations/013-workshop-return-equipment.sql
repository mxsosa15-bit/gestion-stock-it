BEGIN;

ALTER TABLE gestion_it.ticket_workshop_transfers
  ADD COLUMN IF NOT EXISTS resultado_equipo text NULL,
  ADD COLUMN IF NOT EXISTS equipo_devuelto text NULL,
  ADD COLUMN IF NOT EXISTS identificacion_devuelta text NULL,
  ADD COLUMN IF NOT EXISTS motivo_reemplazo text NULL;

UPDATE gestion_it.ticket_workshop_transfers
SET resultado_equipo = 'SIN_DATOS'
WHERE estado = 'Devuelto'
  AND resultado_equipo IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ticket_workshop_transfers_return_equipment_check'
      AND conrelid = 'gestion_it.ticket_workshop_transfers'::regclass
  ) THEN
    ALTER TABLE gestion_it.ticket_workshop_transfers
      ADD CONSTRAINT ticket_workshop_transfers_return_equipment_check
      CHECK (
        (
          estado = 'Devuelto'
          AND resultado_equipo IS NOT NULL
          AND (
            (
              resultado_equipo = 'SIN_DATOS'
              AND equipo_devuelto IS NULL
              AND identificacion_devuelta IS NULL
              AND motivo_reemplazo IS NULL
            )
            OR (
              resultado_equipo = 'MISMO'
              AND equipo_devuelto IS NOT NULL
              AND identificacion_devuelta IS NOT NULL
              AND equipo_devuelto = equipo
              AND identificacion_devuelta = identificacion
              AND motivo_reemplazo IS NULL
            )
            OR (
              resultado_equipo = 'REEMPLAZO'
              AND equipo_devuelto IS NOT NULL
              AND identificacion_devuelta IS NOT NULL
              AND motivo_reemplazo IS NOT NULL
              AND length(btrim(equipo_devuelto)) BETWEEN 1 AND 200
              AND length(btrim(identificacion_devuelta)) BETWEEN 1 AND 200
              AND identificacion_devuelta <> identificacion
              AND length(btrim(motivo_reemplazo)) BETWEEN 1 AND 2000
            )
          )
        )
        OR (
          estado <> 'Devuelto'
          AND resultado_equipo IS NULL
          AND equipo_devuelto IS NULL
          AND identificacion_devuelta IS NULL
          AND motivo_reemplazo IS NULL
        )
      );
  END IF;
END;
$$;

COMMIT;

import express from 'express';
import type { Pool } from 'pg';
import { requireRoles } from './session-user';

const requireOperator = requireRoles(['admin', 'operator']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const taskTypes = [
  'Mantenimiento',
  'Instalación',
  'Configuración',
  'Relevamiento',
  'Otro',
] as const;

export interface OperatorTaskInput {
  sedeId: string;
  tipo: (typeof taskTypes)[number];
  titulo: string;
  descripcion: string;
  duracionMinutos: number | null;
}

export function parseOperatorTaskInput(value: unknown): OperatorTaskInput | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const sedeId = typeof body['sedeId'] === 'string' ? body['sedeId'].trim() : '';
  const tipo = body['tipo'];
  const titulo = typeof body['titulo'] === 'string' ? body['titulo'].trim() : '';
  const descripcion = typeof body['descripcion'] === 'string' ? body['descripcion'].trim() : '';
  const rawDuration = body['duracionMinutos'];
  const duracionMinutos = rawDuration === undefined || rawDuration === null ? null : rawDuration;
  if (
    !uuidPattern.test(sedeId) ||
    typeof tipo !== 'string' ||
    !taskTypes.includes(tipo as (typeof taskTypes)[number]) ||
    !titulo ||
    titulo.length > 200 ||
    !descripcion ||
    descripcion.length > 5000 ||
    (duracionMinutos !== null &&
      (!Number.isInteger(duracionMinutos) ||
        Number(duracionMinutos) < 0 ||
        Number(duracionMinutos) > 1440))
  ) {
    return null;
  }
  return {
    sedeId,
    tipo: tipo as (typeof taskTypes)[number],
    titulo,
    descripcion,
    duracionMinutos: duracionMinutos === null ? null : Number(duracionMinutos),
  };
}

export function createOperatorTasksApi(pool: Pool): express.Router {
  const router = express.Router();

  router.get('/operator-tasks', requireOperator, async (request, response, next) => {
    const rawSedeId = request.query['sedeId'];
    if (
      rawSedeId !== undefined &&
      (typeof rawSedeId !== 'string' || !uuidPattern.test(rawSedeId))
    ) {
      response.status(400).json({ error: 'Seleccioná una sede válida.' });
      return;
    }
    try {
      const result = await pool.query(
        `SELECT task.id, task.sede_id AS "sedeId", sede.nombre AS "sedeNombre",
                task.operator_id AS "operadorId", operator.username AS operador,
                task.tipo, task.titulo, task.descripcion,
                task.duracion_minutos AS "duracionMinutos", task.created_at AS "createdAt"
         FROM gestion_it.operator_tasks AS task
         JOIN gestion_it.sedes AS sede ON sede.id = task.sede_id
         JOIN gestion_it.app_users AS operator ON operator.id = task.operator_id
         WHERE ($1::uuid IS NULL OR task.sede_id = $1::uuid)
         ORDER BY task.created_at DESC, task.id DESC`,
        [rawSedeId ?? null],
      );
      response.json(result.rows);
    } catch (error) {
      next(error);
    }
  });

  router.post('/operator-tasks', requireOperator, async (request, response, next) => {
    const task = parseOperatorTaskInput(request.body);
    const operator = request.session.user;
    if (!task || !operator) {
      response.status(400).json({ error: 'Completá los datos de la tarea correctamente.' });
      return;
    }
    try {
      const result = await pool.query(
        `WITH inserted AS (
           INSERT INTO gestion_it.operator_tasks
             (sede_id, operator_id, tipo, titulo, descripcion, duracion_minutos)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *
         )
         SELECT inserted.id, inserted.sede_id AS "sedeId", sede.nombre AS "sedeNombre",
                inserted.tipo, inserted.titulo, inserted.descripcion,
                inserted.duracion_minutos AS "duracionMinutos",
                inserted.created_at AS "createdAt"
         FROM inserted
         JOIN gestion_it.sedes AS sede ON sede.id = inserted.sede_id`,
        [task.sedeId, operator.id, task.tipo, task.titulo, task.descripcion, task.duracionMinutos],
      );
      response.status(201).json({
        ...result.rows[0],
        operadorId: operator.id,
        operador: operator.username,
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23503'
      ) {
        response.status(400).json({ error: 'La sede seleccionada ya no está disponible.' });
        return;
      }
      next(error);
    }
  });

  return router;
}

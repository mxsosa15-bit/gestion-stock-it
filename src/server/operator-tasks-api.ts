import express from 'express';
import type { Pool, PoolClient } from 'pg';
import { parseOptionalDate, parseOptionalText, parsePageOptions } from './list-query';
import { recordOperatorAuditEvents } from './operator-audit';
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
const relatedAssetTypes = ['PUESTO', 'COMPONENTE', 'EQUIPO_RED', 'PATRIMONIAL'] as const;

type RelatedAssetType = (typeof relatedAssetTypes)[number];

export interface OperatorTaskInput {
  sedeId: string;
  areaId: string | null;
  relatedAssetType: RelatedAssetType | null;
  relatedAssetId: string | null;
  operatorId: string | null;
  performedAt: string | null;
  observations: string;
  tipo: (typeof taskTypes)[number];
  titulo: string;
  descripcion: string;
  duracionMinutos: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTaskType(value: unknown): value is (typeof taskTypes)[number] {
  return typeof value === 'string' && taskTypes.some((type) => type === value);
}

function isRelatedAssetType(value: unknown): value is RelatedAssetType {
  return typeof value === 'string' && relatedAssetTypes.some((type) => type === value);
}

function parseNullableText(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const parsed = value.trim();
  return parsed.length > 0 && parsed.length <= maxLength ? parsed : undefined;
}

function parsePerformedAt(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 40) return undefined;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? undefined : timestamp.toISOString();
}

function getSnapshotRecords(snapshot: unknown, key: string): Record<string, unknown>[] {
  if (!isRecord(snapshot) || !Array.isArray(snapshot[key])) return [];
  return snapshot[key].filter(isRecord);
}

function findRelatedSnapshotArea(
  snapshot: unknown,
  type: Exclude<RelatedAssetType, 'PATRIMONIAL'>,
  id: string,
): string | null {
  if (type === 'PUESTO') {
    const workstation = getSnapshotRecords(snapshot, 'puestos').find((item) => item['id'] === id);
    return typeof workstation?.['areaId'] === 'string' ? workstation['areaId'] : null;
  }
  if (type === 'EQUIPO_RED') {
    const equipment = getSnapshotRecords(snapshot, 'equiposRed').find((item) => item['id'] === id);
    return typeof equipment?.['areaId'] === 'string' ? equipment['areaId'] : null;
  }

  for (const workstation of getSnapshotRecords(snapshot, 'puestos')) {
    const components = Array.isArray(workstation['componentes'])
      ? workstation['componentes'].filter(isRecord)
      : [];
    const component = components.find((item) => item['id'] === id);
    if (component) {
      return typeof workstation['areaId'] === 'string' ? workstation['areaId'] : null;
    }
  }
  return null;
}

export function parseOperatorTaskInput(value: unknown): OperatorTaskInput | null {
  if (!isRecord(value)) return null;
  const body = value as Record<string, unknown>;
  const sedeId = typeof body['sedeId'] === 'string' ? body['sedeId'].trim() : '';
  const areaId = parseNullableText(body['areaId'], 120);
  const relatedAssetTypeValue = body['relatedAssetType'];
  const relatedAssetType =
    relatedAssetTypeValue === undefined || relatedAssetTypeValue === null || relatedAssetTypeValue === ''
      ? null
      : isRelatedAssetType(relatedAssetTypeValue)
        ? relatedAssetTypeValue
        : undefined;
  const relatedAssetId = parseNullableText(body['relatedAssetId'], 200);
  const operatorId = parseNullableText(body['operatorId'], 64);
  const performedAt = parsePerformedAt(body['performedAt']);
  const rawObservations = body['observaciones'] ?? body['observations'];
  const observations =
    rawObservations === undefined || rawObservations === null
      ? ''
      : typeof rawObservations === 'string'
        ? rawObservations.trim()
        : undefined;
  const tipo = body['tipo'];
  const titulo = typeof body['titulo'] === 'string' ? body['titulo'].trim() : '';
  const descripcion = typeof body['descripcion'] === 'string' ? body['descripcion'].trim() : '';
  const rawDuration = body['duracionMinutos'];
  const duracionMinutos = rawDuration === undefined || rawDuration === null ? null : rawDuration;
  if (
    !uuidPattern.test(sedeId) ||
    !isTaskType(tipo) ||
    areaId === undefined ||
    relatedAssetType === undefined ||
    relatedAssetId === undefined ||
    operatorId === undefined ||
    (operatorId !== null && !uuidPattern.test(operatorId)) ||
    performedAt === undefined ||
    observations === undefined ||
    observations.length > 5000 ||
    ((relatedAssetType === null) !== (relatedAssetId === null)) ||
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
    areaId,
    relatedAssetType,
    relatedAssetId,
    operatorId,
    performedAt,
    observations,
    tipo,
    titulo,
    descripcion,
    duracionMinutos: duracionMinutos === null ? null : Number(duracionMinutos),
  };
}

interface TaskAreaOption {
  id: string;
  nombre: string;
}

interface TaskOperatorOption {
  id: string;
  username: string;
}

interface TaskAssetOption {
  id: string;
  type: RelatedAssetType;
  label: string;
  areaId: string | null;
}

class OperatorTaskValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperatorTaskValidationError';
  }
}

class OperatorTaskPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperatorTaskPermissionError';
  }
}

async function validateTaskSite(client: PoolClient, sedeId: string): Promise<void> {
  const site = await client.query(
    'SELECT id FROM gestion_it.sedes WHERE id = $1::uuid AND activa = true FOR SHARE',
    [sedeId],
  );
  if (!site.rowCount) throw new OperatorTaskValidationError('La sede seleccionada no está disponible.');
}

async function resolveTaskOperator(
  client: PoolClient,
  actor: NonNullable<express.Request['session']['user']>,
  requestedOperatorId: string | null,
): Promise<string> {
  if (actor.role !== 'admin') {
    if (requestedOperatorId && requestedOperatorId !== actor.id) {
      throw new OperatorTaskPermissionError('Solo una persona administradora puede asignar tareas a otros operadores.');
    }
    return actor.id;
  }
  const operatorId = requestedOperatorId ?? actor.id;
  const operator = await client.query(
    `SELECT id
     FROM gestion_it.app_users
     WHERE id = $1::uuid AND role IN ('admin', 'operator')
     FOR SHARE`,
    [operatorId],
  );
  if (!operator.rowCount) {
    throw new OperatorTaskValidationError('El responsable seleccionado no es un operador habilitado.');
  }
  return operatorId;
}

async function validateTaskReferences(
  client: PoolClient,
  task: OperatorTaskInput,
  snapshot: unknown,
): Promise<{ areaDatabaseId: string | null; areaInventoryId: string | null }> {
  let relatedAreaId: string | null = null;
  if (task.relatedAssetType && task.relatedAssetId) {
    if (task.relatedAssetType === 'PATRIMONIAL') {
      if (!uuidPattern.test(task.relatedAssetId)) {
        throw new OperatorTaskValidationError('El equipo patrimonial seleccionado no es válido.');
      }
      const asset = await client.query(
        `SELECT id
         FROM gestion_it.hardware_assets
         WHERE id = $1::uuid AND sede_id = $2::uuid
         FOR SHARE`,
        [task.relatedAssetId, task.sedeId],
      );
      if (!asset.rowCount) {
        throw new OperatorTaskValidationError('El equipo patrimonial no pertenece a la sede seleccionada.');
      }
    } else {
      relatedAreaId = findRelatedSnapshotArea(snapshot, task.relatedAssetType, task.relatedAssetId);
      if (!relatedAreaId) {
        throw new OperatorTaskValidationError('El puesto o equipo relacionado ya no está disponible.');
      }
    }
  }

  if (task.areaId && relatedAreaId && task.areaId !== relatedAreaId) {
    throw new OperatorTaskValidationError('El área debe coincidir con la ubicación del equipo relacionado.');
  }
  const areaInventoryId = task.areaId ?? relatedAreaId;
  if (!areaInventoryId) return { areaDatabaseId: null, areaInventoryId: null };

  const area = await client.query<{ id: string }>(
    `SELECT id::text AS id
     FROM gestion_it.areas
     WHERE inventory_area_id = $1
       AND sede_id = $2::uuid
       AND activo = true
     FOR SHARE`,
    [areaInventoryId, task.sedeId],
  );
  if (!area.rows[0]) {
    throw new OperatorTaskValidationError('El área no pertenece a la sede seleccionada o ya no está disponible.');
  }
  return { areaDatabaseId: area.rows[0].id, areaInventoryId };
}

async function selectTaskById(client: PoolClient, taskId: string): Promise<Record<string, unknown> | null> {
  const result = await client.query(
    `SELECT task.id, task.sede_id AS "sedeId", sede.nombre AS "sedeNombre",
            task.operator_id AS "operadorId", operator.username AS operador,
            task.tipo, task.titulo, task.descripcion,
            task.duracion_minutos AS "duracionMinutos",
            task.performed_at AS "performedAt", task.created_at AS "createdAt",
            area.inventory_area_id AS "areaId", area.nombre AS "areaNombre",
            task.related_asset_type AS "relatedAssetType",
            task.related_asset_id AS "relatedAssetId",
            task.observations AS observaciones
     FROM gestion_it.operator_tasks AS task
     JOIN gestion_it.sedes AS sede ON sede.id = task.sede_id
     JOIN gestion_it.app_users AS operator ON operator.id = task.operator_id
     LEFT JOIN gestion_it.areas AS area ON area.id = task.area_id
     WHERE task.id = $1::uuid`,
    [taskId],
  );
  return result.rows[0] ?? null;
}

function taskAuditDetails(task: Record<string, unknown>): Record<string, unknown> {
  return {
    titulo: task['titulo'],
    tipo: task['tipo'],
    descripcion: task['descripcion'],
    operadorId: task['operadorId'],
    operador: task['operador'],
    sedeId: task['sedeId'],
    sede: task['sedeNombre'],
    areaId: task['areaId'],
    area: task['areaNombre'],
    equipoRelacionadoTipo: task['relatedAssetType'],
    equipoRelacionadoId: task['relatedAssetId'],
    duracionMinutos: task['duracionMinutos'],
    realizadaEn: task['performedAt'],
    observaciones: task['observaciones'],
  };
}

export function createOperatorTasksApi(pool: Pool): express.Router {
  const router = express.Router();

  router.get('/operator-tasks/options', requireOperator, async (request, response, next) => {
    const rawSedeId = request.query['sedeId'];
    if (typeof rawSedeId !== 'string' || !uuidPattern.test(rawSedeId)) {
      response.status(400).json({ error: 'Seleccioná una sede válida.' });
      return;
    }
    try {
      const site = await pool.query(
        'SELECT id FROM gestion_it.sedes WHERE id = $1::uuid AND activa = true',
        [rawSedeId],
      );
      if (!site.rowCount) {
        response.status(404).json({ error: 'La sede seleccionada no está disponible.' });
        return;
      }
      const actor = request.session.user;
      if (!actor) {
        response.status(401).json({ error: 'La sesión ya no es válida.' });
        return;
      }
      const [areas, snapshotResult, hardware, operators] = await Promise.all([
        pool.query<TaskAreaOption>(
          `SELECT inventory_area_id AS id, nombre
           FROM gestion_it.areas
           WHERE sede_id = $1::uuid AND activo = true
             AND inventory_area_id IS NOT NULL
           ORDER BY nombre`,
          [rawSedeId],
        ),
        pool.query<{ payload: unknown }>(
          'SELECT payload FROM gestion_it.inventory_snapshot WHERE singleton_id = true',
        ),
        pool.query<{ id: string; tipo: string; marca: string; modelo: string | null }>(
          `SELECT id::text AS id, tipo, marca, modelo
           FROM gestion_it.hardware_assets
           WHERE sede_id = $1::uuid
           ORDER BY tipo, marca, modelo`,
          [rawSedeId],
        ),
        actor.role === 'admin'
          ? pool.query<TaskOperatorOption>(
              `SELECT id::text AS id, username
               FROM gestion_it.app_users
               WHERE role IN ('admin', 'operator')
               ORDER BY username`,
            )
          : Promise.resolve({ rows: [{ id: actor.id, username: actor.username }] }),
      ]);
      const validAreaIds = new Set(areas.rows.map((area) => area.id));
      const snapshot = snapshotResult.rows[0]?.payload;
      const relatedAssets: TaskAssetOption[] = [];

      for (const workstation of getSnapshotRecords(snapshot, 'puestos')) {
        const areaId = typeof workstation['areaId'] === 'string' ? workstation['areaId'] : null;
        if (areaId && validAreaIds.has(areaId) && typeof workstation['id'] === 'string') {
          relatedAssets.push({
            id: workstation['id'],
            type: 'PUESTO',
            label: `Puesto: ${String(workstation['nombrePuesto'] ?? workstation['id'])}`,
            areaId,
          });
        }
        const components = Array.isArray(workstation['componentes'])
          ? workstation['componentes'].filter(isRecord)
          : [];
        for (const component of components) {
          if (typeof component['id'] !== 'string' || !areaId || !validAreaIds.has(areaId)) continue;
          relatedAssets.push({
            id: component['id'],
            type: 'COMPONENTE',
            label: `${String(component['tipo'] ?? 'Componente')} ${String(component['marca'] ?? '')} ${String(component['modelo'] ?? '')}`.trim(),
            areaId,
          });
        }
      }
      for (const equipment of getSnapshotRecords(snapshot, 'equiposRed')) {
        const areaId = typeof equipment['areaId'] === 'string' ? equipment['areaId'] : null;
        if (!areaId || !validAreaIds.has(areaId) || typeof equipment['id'] !== 'string') continue;
        relatedAssets.push({
          id: equipment['id'],
          type: 'EQUIPO_RED',
          label: `${String(equipment['tipo'] ?? 'Equipo de red')} ${String(equipment['marca'] ?? '')} ${String(equipment['modelo'] ?? '')}`.trim(),
          areaId,
        });
      }
      relatedAssets.push(
        ...hardware.rows.map((asset) => ({
          id: asset.id,
          type: 'PATRIMONIAL' as const,
          label: `${asset.tipo} ${asset.marca} ${asset.modelo ?? ''}`.trim(),
          areaId: null,
        })),
      );
      response.json({
        areas: areas.rows.map(({ id, nombre }) => ({ id, nombre })),
        operators: operators.rows,
        relatedAssets,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/operator-tasks', requireOperator, async (request, response, next) => {
    const rawSedeId = request.query['sedeId'];
    const search = parseOptionalText(request.query['search'], 200);
    const operator = parseOptionalText(request.query['operator'], 64);
    const areaId = parseOptionalText(request.query['areaId'], 120);
    const from = parseOptionalDate(request.query['from']);
    const to = parseOptionalDate(request.query['to']);
    const type = parseOptionalText(request.query['type'], 40);
    const sort = parseOptionalText(request.query['sort'], 16);
    const pagination = parsePageOptions(
      request.query['page'],
      request.query['pageSize'],
      25,
    );
    if (
      rawSedeId !== undefined &&
      (typeof rawSedeId !== 'string' || !uuidPattern.test(rawSedeId))
    ) {
      response.status(400).json({ error: 'Seleccioná una sede válida.' });
      return;
    }
    if (
      search === undefined ||
      operator === undefined ||
      areaId === undefined ||
      from === undefined ||
      to === undefined ||
      type === undefined ||
      sort === undefined ||
      pagination === null ||
      (from !== null && to !== null && from > to) ||
      (type !== null && !taskTypes.includes(type as (typeof taskTypes)[number])) ||
      (sort !== null && sort !== 'newest' && sort !== 'oldest')
    ) {
      response.status(400).json({ error: 'Los filtros de tareas no son válidos.' });
      return;
    }

    const values: unknown[] = [];
    const filters: string[] = [];
    const bind = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };
    if (rawSedeId !== undefined) filters.push(`task.sede_id = ${bind(rawSedeId)}::uuid`);
    if (areaId) filters.push(`area.inventory_area_id = ${bind(areaId)}`);
    if (type) filters.push(`task.tipo = ${bind(type)}`);
    if (operator) filters.push(`operator.username ILIKE '%' || ${bind(operator)} || '%'`);
    if (from) filters.push(`task.performed_at >= ${bind(from)}::date`);
    if (to) filters.push(`task.performed_at < ${bind(to)}::date + interval '1 day'`);
    if (search) {
      const term = bind(search);
      filters.push(
        `(task.titulo ILIKE '%' || ${term} || '%'
          OR task.descripcion ILIKE '%' || ${term} || '%'
          OR task.tipo ILIKE '%' || ${term} || '%'
          OR operator.username ILIKE '%' || ${term} || '%'
          OR sede.nombre ILIKE '%' || ${term} || '%'
          OR COALESCE(area.nombre, '') ILIKE '%' || ${term} || '%'
          OR COALESCE(task.observations, '') ILIKE '%' || ${term} || '%'
          OR COALESCE(task.related_asset_type, '') ILIKE '%' || ${term} || '%'
          OR COALESCE(task.related_asset_id, '') ILIKE '%' || ${term} || '%')`,
      );
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    const ordering = sort === 'oldest' ? 'ASC' : 'DESC';
    const hasPagedQuery =
      request.query['page'] !== undefined ||
      request.query['pageSize'] !== undefined ||
      request.query['search'] !== undefined ||
      request.query['operator'] !== undefined ||
      request.query['areaId'] !== undefined ||
      request.query['from'] !== undefined ||
      request.query['to'] !== undefined ||
      request.query['type'] !== undefined ||
      request.query['sort'] !== undefined;

    try {
      const query = `FROM gestion_it.operator_tasks AS task
         JOIN gestion_it.sedes AS sede ON sede.id = task.sede_id
         JOIN gestion_it.app_users AS operator ON operator.id = task.operator_id
         LEFT JOIN gestion_it.areas AS area ON area.id = task.area_id
         ${where}`;
      if (!hasPagedQuery) {
        const result = await pool.query(
        `SELECT task.id, task.sede_id AS "sedeId", sede.nombre AS "sedeNombre",
                task.operator_id AS "operadorId", operator.username AS operador,
                task.tipo, task.titulo, task.descripcion,
                task.duracion_minutos AS "duracionMinutos",
                task.performed_at AS "performedAt", task.created_at AS "createdAt",
                area.inventory_area_id AS "areaId", area.nombre AS "areaNombre",
                task.related_asset_type AS "relatedAssetType",
                task.related_asset_id AS "relatedAssetId",
                task.observations AS observaciones
         ${query}
         ORDER BY task.performed_at ${ordering}, task.id ${ordering}`,
          values,
        );
        response.json(result.rows);
        return;
      }

      const countQuery = `SELECT count(*)::int AS total ${query}`;
      const pageValues = [...values, pagination.pageSize, pagination.offset];
      const [count, result] = await Promise.all([
        pool.query<{ total: number }>(countQuery, values),
        pool.query(
          `SELECT task.id, task.sede_id AS "sedeId", sede.nombre AS "sedeNombre",
                  task.operator_id AS "operadorId", operator.username AS operador,
                  task.tipo, task.titulo, task.descripcion,
                  task.duracion_minutos AS "duracionMinutos",
                  task.performed_at AS "performedAt", task.created_at AS "createdAt",
                  area.inventory_area_id AS "areaId", area.nombre AS "areaNombre",
                  task.related_asset_type AS "relatedAssetType",
                  task.related_asset_id AS "relatedAssetId",
                  task.observations AS observaciones
           ${query}
           ORDER BY task.performed_at ${ordering}, task.id ${ordering}
           LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`,
          pageValues,
        ),
      ]);
      response.json({
        items: result.rows,
        total: count.rows[0]?.total ?? 0,
        page: pagination.page,
        pageSize: pagination.pageSize,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/operator-tasks', requireOperator, async (request, response, next) => {
    const task = parseOperatorTaskInput(request.body);
    const actor = request.session.user;
    if (!task || !actor) {
      response.status(400).json({ error: 'Completá los datos de la tarea correctamente.' });
      return;
    }

    const client = await pool.connect();
    let transactionStarted = false;
    try {
      await client.query('BEGIN');
      transactionStarted = true;
      await validateTaskSite(client, task.sedeId);
      const operatorId = await resolveTaskOperator(client, actor, task.operatorId);
      const snapshotResult = await client.query<{ payload: unknown }>(
        'SELECT payload FROM gestion_it.inventory_snapshot WHERE singleton_id = true FOR SHARE',
      );
      const references = await validateTaskReferences(
        client,
        task,
        snapshotResult.rows[0]?.payload,
      );
      const inserted = await client.query(
        `INSERT INTO gestion_it.operator_tasks
           (sede_id, operator_id, tipo, titulo, descripcion, duracion_minutos,
            performed_at, area_id, related_asset_type, related_asset_id, observations)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, COALESCE($7::timestamptz, now()),
                 $8::uuid, $9, $10, $11)
         RETURNING id::text AS id`,
        [
          task.sedeId,
          operatorId,
          task.tipo,
          task.titulo,
          task.descripcion,
          task.duracionMinutos,
          task.performedAt,
          references.areaDatabaseId,
          task.relatedAssetType,
          task.relatedAssetId,
          task.observations,
        ],
      );
      const created = await selectTaskById(client, inserted.rows[0]?.id);
      if (!created) throw new Error('No se pudo recuperar la tarea guardada.');
      await recordOperatorAuditEvents(client, actor, [
        {
          action: 'Registró una tarea de operador',
          entityType: 'tarea de operador',
          entityId: String(created['id']),
          entityName: String(created['titulo'] ?? ''),
          details: {
            resultado: 'exitoso',
            posterior: taskAuditDetails(created),
          },
        },
      ]);
      await client.query('COMMIT');
      transactionStarted = false;
      response.locals['operatorAuditRecordedTransactionally'] = true;
      response.status(201).json(created);
    } catch (error) {
      if (transactionStarted) await client.query('ROLLBACK');
      if (error instanceof OperatorTaskPermissionError) {
        response.status(403).json({ error: error.message });
        return;
      }
      if (error instanceof OperatorTaskValidationError) {
        response.status(400).json({ error: error.message });
        return;
      }
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23503'
      ) {
        response.status(400).json({ error: 'La sede, el área o el operador seleccionado ya no está disponible.' });
        return;
      }
      next(error);
    } finally {
      client.release();
    }
  });

  router.put('/operator-tasks/:id', requireOperator, async (request, response, next) => {
    const taskId = request.params['id'];
    const task = parseOperatorTaskInput(request.body);
    const actor = request.session.user;
    if (typeof taskId !== 'string' || !uuidPattern.test(taskId) || !task || !actor) {
      response.status(400).json({ error: 'Los datos de la tarea no son válidos.' });
      return;
    }

    const client = await pool.connect();
    let transactionStarted = false;
    try {
      await client.query('BEGIN');
      transactionStarted = true;
      const existingResult = await client.query<{
        sede_id: string;
        operator_id: string;
        area_id: string | null;
        area_inventory_id: string | null;
        related_asset_type: RelatedAssetType | null;
        related_asset_id: string | null;
        performed_at: Date;
      }>(
        `SELECT task.sede_id::text AS sede_id, task.operator_id::text AS operator_id,
                task.area_id::text AS area_id, area.inventory_area_id AS area_inventory_id,
                task.related_asset_type, task.related_asset_id, task.performed_at
         FROM gestion_it.operator_tasks AS task
         LEFT JOIN gestion_it.areas AS area ON area.id = task.area_id
         WHERE task.id = $1::uuid
         FOR UPDATE OF task`,
        [taskId],
      );
      const existing = existingResult.rows[0];
      if (!existing) {
        await client.query('ROLLBACK');
        transactionStarted = false;
        response.status(404).json({ error: 'No se encontró la tarea solicitada.' });
        return;
      }
      const beforeTask = await selectTaskById(client, taskId);
      if (!beforeTask) throw new Error('No se pudo recuperar la tarea antes de editarla.');
      if (actor.role !== 'admin' && existing.operator_id !== actor.id) {
        await client.query('ROLLBACK');
        transactionStarted = false;
        response.status(403).json({ error: 'Solo podés editar las tareas que registraste.' });
        return;
      }
      if (actor.role !== 'admin' && task.operatorId && task.operatorId !== actor.id) {
        throw new OperatorTaskPermissionError('Solo una persona administradora puede reasignar una tarea.');
      }

      await validateTaskSite(client, task.sedeId);
      const operatorId =
        actor.role === 'admin'
          ? task.operatorId && task.operatorId !== existing.operator_id
            ? await resolveTaskOperator(client, actor, task.operatorId)
            : existing.operator_id
          : existing.operator_id;
      const relationshipUnchanged =
        task.sedeId === existing.sede_id &&
        task.areaId === existing.area_inventory_id &&
        task.relatedAssetType === existing.related_asset_type &&
        task.relatedAssetId === existing.related_asset_id;
      let references: { areaDatabaseId: string | null; areaInventoryId: string | null };
      if (relationshipUnchanged) {
        references = {
          areaDatabaseId: existing.area_id,
          areaInventoryId: existing.area_inventory_id,
        };
      } else {
        const snapshotResult = await client.query<{ payload: unknown }>(
          'SELECT payload FROM gestion_it.inventory_snapshot WHERE singleton_id = true FOR SHARE',
        );
        references = await validateTaskReferences(client, task, snapshotResult.rows[0]?.payload);
      }
      await client.query(
        `UPDATE gestion_it.operator_tasks
         SET sede_id = $2::uuid,
             operator_id = $3::uuid,
             tipo = $4,
             titulo = $5,
             descripcion = $6,
             duracion_minutos = $7,
             performed_at = COALESCE($8::timestamptz, $9::timestamptz),
             area_id = $10::uuid,
             related_asset_type = $11,
             related_asset_id = $12,
             observations = $13
         WHERE id = $1::uuid`,
        [
          taskId,
          task.sedeId,
          operatorId,
          task.tipo,
          task.titulo,
          task.descripcion,
          task.duracionMinutos,
          task.performedAt,
          existing.performed_at,
          references.areaDatabaseId,
          task.relatedAssetType,
          task.relatedAssetId,
          task.observations,
        ],
      );
      const updated = await selectTaskById(client, taskId);
      if (!updated) throw new Error('No se pudo recuperar la tarea actualizada.');
      await recordOperatorAuditEvents(client, actor, [
        {
          action: 'Actualizó una tarea de operador',
          entityType: 'tarea de operador',
          entityId: taskId,
          entityName: String(updated['titulo'] ?? ''),
          details: {
            resultado: 'exitoso',
            anterior: taskAuditDetails(beforeTask),
            posterior: taskAuditDetails(updated),
          },
        },
      ]);
      await client.query('COMMIT');
      transactionStarted = false;
      response.locals['operatorAuditRecordedTransactionally'] = true;
      response.json(updated);
    } catch (error) {
      if (transactionStarted) await client.query('ROLLBACK');
      if (error instanceof OperatorTaskPermissionError) {
        response.status(403).json({ error: error.message });
        return;
      }
      if (error instanceof OperatorTaskValidationError) {
        response.status(400).json({ error: error.message });
        return;
      }
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23503'
      ) {
        response.status(400).json({ error: 'La sede, el área o el operador seleccionado ya no está disponible.' });
        return;
      }
      next(error);
    } finally {
      client.release();
    }
  });

  return router;
}

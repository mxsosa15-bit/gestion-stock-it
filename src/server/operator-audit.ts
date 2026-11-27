import { isDeepStrictEqual } from 'node:util';
import type { Request, Response } from 'express';
import type { Pool, PoolClient } from 'pg';
import type { SessionUser } from './session-user';

export interface OperatorAuditEvent {
  action: string;
  entityType: string;
  entityId: string | null;
  entityName: string | null;
  details: Record<string, unknown>;
}

export interface OperatorAuditHistoryEvent extends OperatorAuditEvent {
  id: string;
  actorId: string;
  actorUsername: string;
  createdAt: string;
}

interface InventoryChange {
  action: string;
  type: string;
  name: string;
  id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

const inventoryCollections = [
  { key: 'pisos', label: 'piso', nameKeys: ['nombre'] },
  { key: 'areas', label: 'área', nameKeys: ['nombre'] },
  { key: 'personas', label: 'persona asignada', nameKeys: [] },
  { key: 'puestos', label: 'puesto', nameKeys: ['nombrePuesto'] },
  { key: 'stock', label: 'insumo de stock', nameKeys: ['tipo', 'marca'] },
  { key: 'equiposRed', label: 'equipo de red', nameKeys: ['tipo', 'marca'] },
  { key: 'componentesRetirados', label: 'componente retirado', nameKeys: ['estado'] },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function inventoryHistoryAuditEvents(history: unknown): OperatorAuditHistoryEvent[] {
  if (!Array.isArray(history)) return [];

  return history.flatMap((entry): OperatorAuditHistoryEvent[] => {
    if (!isRecord(entry)) return [];
    const id = entry['id'];
    const actorId = entry['operadorId'];
    const actorUsername = entry['operador'];
    const createdAt = entry['fecha'];
    const type = entry['tipo'];
    const name = entry['detalle'];
    const timestamp = typeof createdAt === 'string' ? new Date(createdAt) : null;
    if (
      typeof id !== 'string' ||
      !id ||
      typeof actorId !== 'string' ||
      !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(actorId) ||
      typeof actorUsername !== 'string' ||
      !actorUsername.trim() ||
      !timestamp ||
      Number.isNaN(timestamp.getTime())
    ) {
      return [];
    }

    return [
      {
        id: `historial-${id}`,
        actorId,
        actorUsername,
        action: 'Registró un movimiento de inventario',
        entityType: 'inventario',
        entityId: id,
        entityName: typeof name === 'string' ? sanitizeAuditString(name) : null,
        details: { tipo: typeof type === 'string' ? type : '' },
        createdAt: timestamp.toISOString(),
      },
    ];
  });
}

export async function excludeAuditedStockMovementHistory(
  pool: Pool,
  events: OperatorAuditHistoryEvent[],
): Promise<OperatorAuditHistoryEvent[]> {
  const movementIds = events
    .map((event) => event.entityId)
    .filter((id): id is string => id !== null);
  if (movementIds.length === 0) return events;

  const result = await pool.query<{ entity_id: string }>(
    `SELECT entity_id
     FROM gestion_it.operator_audit_events
     WHERE entity_type = 'transferencia de stock'
       AND entity_id = ANY($1::text[])
     UNION
     SELECT entry->>'registroId' AS entity_id
     FROM gestion_it.operator_audit_events AS event
     CROSS JOIN LATERAL jsonb_array_elements(
       CASE
         WHEN jsonb_typeof(event.details->'registros') = 'array'
           THEN event.details->'registros'
         ELSE '[]'::jsonb
       END
     ) AS entries(entry)
     WHERE event.entity_type = 'inventario'
       AND entry->>'tipo' = 'movimiento de inventario'
       AND entry->>'registroId' = ANY($1::text[])
     UNION
     SELECT movement_id AS entity_id
     FROM gestion_it.operator_audit_events AS event
     CROSS JOIN LATERAL jsonb_array_elements_text(
       CASE
         WHEN jsonb_typeof(event.details->'historialMovimientoIds') = 'array'
           THEN event.details->'historialMovimientoIds'
         ELSE '[]'::jsonb
       END
     ) AS entries(movement_id)
     WHERE event.entity_type = 'inventario'
       AND movement_id = ANY($1::text[])`,
    [movementIds],
  );
  const recordedIds = new Set(result.rows.map((row) => row.entity_id));
  return events.filter((event) => event.entityId === null || !recordedIds.has(event.entityId));
}

function recordsById(value: unknown): Map<string, Record<string, unknown>> {
  if (!Array.isArray(value)) return new Map();
  return new Map(
    value.filter(isRecord).flatMap((record) => {
      const id = record['id'];
      return typeof id === 'string' ? [[id, record]] : [];
    }),
  );
}

function recordName(record: Record<string, unknown>, keys: readonly string[]): string {
  const name = keys
    .map((key) => record[key])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ');
  return name || String(record['id'] ?? 'sin identificar');
}

function withoutComponents(record: Record<string, unknown>): Record<string, unknown> {
  const { componentes: _componentes, ...values } = record;
  return values;
}

function inventoryAuditSnapshot(
  type: string,
  record: Record<string, unknown>,
): Record<string, unknown> {
  const fields: Record<string, readonly string[]> = {
    piso: ['nombre', 'nivel', 'sedeId'],
    área: ['nombre', 'pisoId'],
    'persona asignada': ['areaId', 'puestoId'],
    puesto: ['nombrePuesto', 'usuarioAsignado', 'areaId', 'codigoSeguimiento'],
    'insumo de stock': [
      'tipo',
      'marca',
      'especificacion',
      'cantidadDisponible',
      'stockMinimo',
      'codigoSeguimiento',
      'sedeId',
    ],
    'equipo de red': ['tipo', 'marca', 'modelo', 'areaId', 'codigoSeguimiento'],
    'componente retirado': ['estado', 'fechaRetiro', 'puestoId'],
    'componente de puesto': [
      'tipo',
      'marca',
      'modelo',
      'especificacion',
      'numeroSerie',
      'codigoSeguimiento',
    ],
    'movimiento de inventario': [
      'tipo',
      'fecha',
      'cantidad',
      'detalle',
      'sedeId',
      'insumoId',
      'puestoId',
      'equipoRedId',
      'componenteRetiradoId',
      'operadorId',
      'operador',
    ],
  };
  const snapshot: Record<string, unknown> = {};
  for (const key of fields[type] ?? []) {
    const value = record[key];
    if (typeof value === 'string') snapshot[key] = value.slice(0, 250);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      snapshot[key] = value;
    }
  }
  return snapshot;
}

function collectInventoryChanges(before: unknown, after: unknown): InventoryChange[] {
  if (!isRecord(before) || !isRecord(after)) return [];
  const changes: InventoryChange[] = [];

  for (const collection of inventoryCollections) {
    const previous = recordsById(before[collection.key]);
    const current = recordsById(after[collection.key]);
    for (const [id, record] of current) {
      const oldRecord = previous.get(id);
      if (!oldRecord) {
        changes.push({
          action: 'Creó',
          type: collection.label,
          name: recordName(record, collection.nameKeys),
          id,
          before: null,
          after: inventoryAuditSnapshot(collection.label, record),
        });
      } else {
        const oldValue = collection.key === 'puestos' ? withoutComponents(oldRecord) : oldRecord;
        const newValue = collection.key === 'puestos' ? withoutComponents(record) : record;
        if (!isDeepStrictEqual(oldValue, newValue)) {
          changes.push({
            action: 'Actualizó',
            type: collection.label,
            name: recordName(record, collection.nameKeys),
            id,
            before: inventoryAuditSnapshot(collection.label, oldRecord),
            after: inventoryAuditSnapshot(collection.label, record),
          });
        }
      }
    }
    for (const [id, record] of previous) {
      if (!current.has(id)) {
        changes.push({
          action: 'Eliminó',
          type: collection.label,
          name: recordName(record, collection.nameKeys),
          id,
          before: inventoryAuditSnapshot(collection.label, record),
          after: null,
        });
      }
    }
  }

  const previousHistory = recordsById(before['historial']);
  const currentHistory = recordsById(after['historial']);
  for (const [id, record] of currentHistory) {
    const oldRecord = previousHistory.get(id);
    if (!oldRecord) {
      changes.push({
        action: 'Registró',
        type: 'movimiento de inventario',
        name: recordName(record, ['detalle', 'tipo']),
        id,
        before: null,
        after: inventoryAuditSnapshot('movimiento de inventario', record),
      });
    } else if (!isDeepStrictEqual(oldRecord, record)) {
      changes.push({
        action: 'Modificó',
        type: 'movimiento de inventario',
        name: recordName(record, ['detalle', 'tipo']),
        id,
        before: inventoryAuditSnapshot('movimiento de inventario', oldRecord),
        after: inventoryAuditSnapshot('movimiento de inventario', record),
      });
    }
  }
  for (const [id, record] of previousHistory) {
    if (!currentHistory.has(id)) {
      changes.push({
        action: 'Eliminó',
        type: 'movimiento de inventario',
        name: recordName(record, ['detalle', 'tipo']),
        id,
        before: inventoryAuditSnapshot('movimiento de inventario', record),
        after: null,
      });
    }
  }

  const previousComponents = new Map<string, Record<string, unknown>>();
  const currentComponents = new Map<string, Record<string, unknown>>();
  for (const [target, snapshot] of [
    [previousComponents, before],
    [currentComponents, after],
  ] as const) {
    if (!isRecord(snapshot) || !Array.isArray(snapshot['puestos'])) continue;
    for (const workstation of snapshot['puestos']) {
      if (!isRecord(workstation) || !Array.isArray(workstation['componentes'])) continue;
      for (const component of workstation['componentes']) {
        if (isRecord(component) && typeof component['id'] === 'string') {
          target.set(component['id'], component);
        }
      }
    }
  }
  for (const [id, component] of currentComponents) {
    const oldComponent = previousComponents.get(id);
    const name = recordName(component, ['tipo', 'marca']);
    if (!oldComponent) {
      changes.push({
        action: 'Agregó',
        type: 'componente de puesto',
        name,
        id,
        before: null,
        after: inventoryAuditSnapshot('componente de puesto', component),
      });
    } else if (!isDeepStrictEqual(oldComponent, component)) {
      changes.push({
        action: 'Actualizó',
        type: 'componente de puesto',
        name,
        id,
        before: inventoryAuditSnapshot('componente de puesto', oldComponent),
        after: inventoryAuditSnapshot('componente de puesto', component),
      });
    }
  }
  for (const [id, component] of previousComponents) {
    if (!currentComponents.has(id)) {
      changes.push({
        action: 'Retiró',
        type: 'componente de puesto',
        name: recordName(component, ['tipo', 'marca']),
        id,
        before: inventoryAuditSnapshot('componente de puesto', component),
        after: null,
      });
    }
  }

  return changes;
}

export function describeInventoryChange(before: unknown, after: unknown): OperatorAuditEvent[] {
  const changes = collectInventoryChanges(before, after);
  if (changes.length === 0) return [];

  const grouped = new Map<
    string,
    { action: string; type: string; count: number; names: string[] }
  >();
  for (const change of changes) {
    const key = `${change.action}\u0000${change.type}`;
    const group = grouped.get(key) ?? {
      action: change.action,
      type: change.type,
      count: 0,
      names: [],
    };
    group.count += 1;
    if (group.names.length < 5) group.names.push(change.name);
    grouped.set(key, group);
  }

  return [
    {
      action: 'Actualizó el inventario',
      entityType: 'inventario',
      entityId: null,
      entityName: [...grouped.values()]
        .map((group) => {
          const type =
            group.type === 'movimiento de inventario' && group.count > 1
              ? 'movimientos de inventario'
              : `${group.type}${group.count === 1 ? '' : 's'}`;
          const examples = group.names.join(', ');
          const more = group.count > group.names.length ? ', …' : '';
          return `${group.action} ${group.count} ${type} (${examples}${more})`;
        })
        .join('; ')
        .slice(0, 500),
      details: {
        cambios: [...grouped.values()],
        registros: changes.slice(0, 100).map((change) => ({
          accion: change.action,
          tipo: change.type,
          registroId: change.id,
          anterior: change.before,
          posterior: change.after,
        })),
        historialMovimientoIds: changes
          .filter((change) => change.type === 'movimiento de inventario')
          .map((change) => change.id),
        registrosOmitidos: Math.max(0, changes.length - 100),
      },
    },
  ];
}

function mutationEvent(request: Request): OperatorAuditEvent | null {
  const path = request.path;
  const method = request.method;
  let action = `Realizó una acción (${method})`;
  let entityType = 'sistema';
  let entityId: string | null = null;

  if (path === '/admin/users' && method === 'POST') {
    action = 'Creó un usuario';
    entityType = 'usuario';
  } else if (/^\/admin\/users\/[^/]+$/.test(path) && method === 'PATCH') {
    action = 'Actualizó el perfil de un usuario';
    entityType = 'usuario';
    entityId = path.split('/')[3] ?? null;
  } else if (/^\/admin\/users\/[^/]+\/password$/.test(path) && method === 'PUT') {
    action = 'Restableció una contraseña';
    entityType = 'usuario';
    entityId = path.split('/')[3] ?? null;
  } else if (path === '/tickets' && method === 'POST') {
    action = 'Creó un reclamo';
    entityType = 'reclamo';
  } else if (/^\/tickets\/[^/]+\/details$/.test(path) && method === 'PATCH') {
    action = 'Editó los datos de un reclamo abierto';
    entityType = 'reclamo';
    entityId = path.split('/')[2] ?? null;
  } else if (path === '/operator-tasks' && method === 'POST') {
    action = 'Registró una tarea de operador';
    entityType = 'tarea de operador';
  } else if (/^\/operator-tasks\/[^/]+$/.test(path) && method === 'PUT') {
    action = 'Actualizó una tarea de operador';
    entityType = 'tarea de operador';
    entityId = path.split('/')[2] ?? null;
  } else if (/^\/tickets\/[^/]+\/workshop$/.test(path) && method === 'POST') {
    action = 'Derivó un reclamo al taller';
    entityType = 'reclamo';
    entityId = path.split('/')[2] ?? null;
  } else if (/^\/tickets\/[^/]+\/workshop\/[^/]+\/return$/.test(path) && method === 'PATCH') {
    action = 'Registró la devolución y resolución de un reclamo';
    entityType = 'reclamo';
    entityId = path.split('/')[2] ?? null;
  } else if (/^\/tickets\/[^/]+\/workshop\/[^/]+$/.test(path) && method === 'PATCH') {
    action = 'Respondió una derivación de taller';
    entityType = 'reclamo';
    entityId = path.split('/')[2] ?? null;
  } else if (/^\/tickets\/[^/]+$/.test(path) && method === 'PATCH') {
    action = 'Actualizó o resolvió un reclamo';
    entityType = 'reclamo';
    entityId = path.split('/')[2] ?? null;
  } else if (path === '/transferencias' && method === 'POST') {
    action = 'Registró una transferencia de inventario';
    entityType = 'transferencia';
  } else if (path === '/sedes' && method === 'POST') {
    action = 'Registró una sede';
    entityType = 'sede';
  } else if (/^\/sedes\/[^/]+$/.test(path) && method === 'PATCH') {
    action = 'Actualizó los datos descriptivos de una sede';
    entityType = 'sede';
    entityId = path.split('/')[2] ?? null;
  } else if (path === '/inventory/stock-transfers' && method === 'POST') {
    action = 'Envió stock desde Casa Central a una delegación';
    entityType = 'transferencia de stock';
  } else if (path === '/inventory' && method === 'PUT') {
    action = 'Actualizó el inventario';
    entityType = 'inventario';
  } else if (path === '/inventory/import' && method === 'POST') {
    action = 'Importó un inventario';
    entityType = 'inventario';
  } else if (path === '/hardware-assets' && method === 'POST') {
    action = 'Registró un equipo patrimonial';
    entityType = 'equipo patrimonial';
  } else if (path === '/hardware-assets/import' && method === 'POST') {
    action = 'Importó equipos patrimoniales';
    entityType = 'equipo patrimonial';
  } else if (/^\/hardware-assets\/[^/]+\/details$/.test(path) && method === 'PATCH') {
    action = 'Actualizó los datos descriptivos de un equipo patrimonial';
    entityType = 'equipo patrimonial';
    entityId = path.split('/')[2] ?? null;
  } else if (/^\/hardware-assets\/[^/]+\/patrimony$/.test(path) && method === 'PUT') {
    action = 'Actualizó un número patrimonial';
    entityType = 'equipo patrimonial';
    entityId = path.split('/')[2] ?? null;
  } else if (/^\/inventory\/puestos\/[^/]+\/componentes\/[^/]+$/.test(path) && method === 'PATCH') {
    action = 'Corrigió administrativamente un componente';
    entityType = 'componente';
    entityId = path.split('/').at(-1) ?? null;
  } else {
    return null;
  }

  return { action, entityType, entityId, entityName: null, details: {} };
}

interface StockShipmentAuditContext {
  idempotencyKey: string;
  movementId: string;
  alreadyProcessed: boolean;
}

function isStockShipmentAuditContext(value: unknown): value is StockShipmentAuditContext {
  if (!isRecord(value)) return false;
  return (
    typeof value['idempotencyKey'] === 'string' &&
    typeof value['movementId'] === 'string' &&
    typeof value['alreadyProcessed'] === 'boolean'
  );
}

function addResponseAuditContext(
  event: OperatorAuditEvent,
  value: unknown,
): OperatorAuditEvent {
  if (!isRecord(value)) return event;
  const details = isRecord(value['details']) ? value['details'] : {};
  return {
    ...event,
    entityId: typeof value['entityId'] === 'string' ? value['entityId'] : event.entityId,
    entityName: typeof value['entityName'] === 'string' ? value['entityName'] : event.entityName,
    details: { ...event.details, ...details },
  };
}

type AuditQueryClient = Pick<Pool, 'query'>;

async function writeAuditEvents(
  database: AuditQueryClient,
  actor: SessionUser,
  events: OperatorAuditEvent[],
): Promise<void> {
  if (events.length === 0) return;
  await database.query(
    `INSERT INTO gestion_it.operator_audit_events
       (actor_id, actor_username, action, entity_type, entity_id, entity_name, details)
     SELECT $1, $2, event.action, event.entity_type, event.entity_id,
            event.entity_name, event.details
     FROM jsonb_to_recordset($3::jsonb) AS event(
       action text, entity_type text, entity_id text, entity_name text, details jsonb
     )`,
    [actor.id, actor.username, serializeAuditEvents(events)],
  );
}

async function saveAuditEvents(
  pool: Pool,
  actor: SessionUser,
  events: OperatorAuditEvent[],
): Promise<void> {
  await writeAuditEvents(pool, actor, events);
}

export async function recordOperatorAuditEvents(
  client: PoolClient,
  actor: SessionUser,
  events: OperatorAuditEvent[],
): Promise<void> {
  await writeAuditEvents(client, actor, events);
}

function sanitizeAuditEvents(events: OperatorAuditEvent[]): OperatorAuditEvent[] {
  return events.map((event) => ({
    ...event,
    action: sanitizeAuditString(event.action),
    entityType: sanitizeAuditString(event.entityType),
    entityId: event.entityId === null ? null : sanitizeAuditString(event.entityId),
    entityName: event.entityName === null ? null : sanitizeAuditString(event.entityName),
    details: sanitizeAuditRecord(event.details),
  }));
}

function serializeAuditEvents(events: OperatorAuditEvent[]): string {
  return JSON.stringify(
    sanitizeAuditEvents(events).map((event) => ({
      action: event.action,
      entity_type: event.entityType,
      entity_id: event.entityId,
      entity_name: event.entityName,
      details: event.details,
    })),
  );
}

function sanitizeAuditRecord(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    sanitized[key] = isSensitiveAuditKey(key) ? '[REDACTED]' : sanitizeAuditValue(entry);
  }
  return sanitized;
}

function sanitizeAuditValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeAuditString(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sanitizeAuditValue);
  if (isRecord(value)) return sanitizeAuditRecord(value);
  return value;
}

function isSensitiveAuditKey(key: string): boolean {
  return /(password|passphrase|token|secret|authorization|cookie|credential|api[_-]?key|private[_-]?key|access[_-]?key)/i.test(
    key,
  );
}

function sanitizeAuditString(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]*)?\b/g, '[REDACTED]')
    .replace(
      /\b(access[_-]?token|refresh[_-]?token)\b(\s*[:=]\s*|\s+)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1$2[REDACTED]',
    )
    .replace(
      /\b(password|passphrase|passwd|secret)\b(\s*[:=]\s*|\s+)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1$2[REDACTED]',
    )
    .replace(
      /\b(token|authorization|cookie|credential)\b(\s*[:=]\s*|\s+)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1$2[REDACTED]',
    )
    .replace(
      /\b(api[_-]?key|client[_-]?secret|private[_-]?key|access[_-]?key|secret[_-]?key)\b(\s*[:=]\s*|\s+)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1$2[REDACTED]',
    );
}

export function installOperatorAuditMiddleware(
  pool: Pool,
): (request: Request, response: Response, next: (error?: unknown) => void) => void {
  return (request, response, next) => {
    const actor = request.session.user;
    if (
      !actor ||
      ['GET', 'HEAD', 'OPTIONS'].includes(request.method) ||
      request.path.startsWith('/auth/')
    ) {
      next();
      return;
    }

    const event = mutationEvent(request);
    if (!event) {
      console.error('No existe una definición de auditoría para la mutación solicitada.', {
        method: request.method,
        path: request.path,
      });
      next();
      return;
    }
    const isStockShipment =
      request.path === '/inventory/stock-transfers' && request.method === 'POST';
    response.once('finish', () => {
      const succeeded = response.statusCode >= 200 && response.statusCode < 300;
      if (response.locals['operatorAuditRecordedTransactionally'] === true) return;
      if (succeeded && isStockShipment) {
        const context = response.locals['stockShipmentAudit'];
        if (!isStockShipmentAuditContext(context)) {
          console.error('Faltan datos de auditoría para el envío de stock.');
          return;
        }
        if (!context.alreadyProcessed) return;
        const replayEvent: OperatorAuditEvent = {
          ...event,
          action: 'Reintentó un envío de stock ya procesado',
          entityType: 'reintento de envío de stock',
          entityId: context.movementId,
          entityName: 'Reintento idempotente',
          details: {
            idempotencyKey: context.idempotencyKey,
            movementId: context.movementId,
            resultado: 'ya_procesado',
            codigoHttp: response.statusCode,
          },
        };
        void saveAuditEvents(pool, actor, [replayEvent]).catch((error: unknown) => {
          console.error('No se pudo guardar el registro de auditoría de operadores.', error);
        });
        return;
      }

      const contextualEvent = addResponseAuditContext(
        event,
        response.locals['operatorAuditContext'],
      );
      const resultEvent: OperatorAuditEvent = {
        ...contextualEvent,
        details: {
          ...contextualEvent.details,
          resultado: succeeded
            ? 'exitoso'
            : response.statusCode >= 500 || response.statusCode === 408
              ? 'resultado_incierto'
              : 'fallido',
          codigoHttp: response.statusCode,
        },
      };
      void saveAuditEvents(pool, actor, [resultEvent]).catch((error: unknown) => {
        console.error('No se pudo guardar el registro de auditoría de operadores.', error);
      });
    });
    next();
  };
}

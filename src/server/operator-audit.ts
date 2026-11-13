import { isDeepStrictEqual } from 'node:util';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
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
}

const inventoryCollections = [
  { key: 'pisos', label: 'piso', nameKeys: ['nombre'] },
  { key: 'areas', label: 'área', nameKeys: ['nombre'] },
  { key: 'personas', label: 'persona asignada', nameKeys: ['nombre'] },
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
        entityId: null,
        entityName: typeof name === 'string' ? name : null,
        details: { tipo: typeof type === 'string' ? type : '' },
        createdAt: timestamp.toISOString(),
      },
    ];
  });
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
        });
      } else {
        const oldValue = collection.key === 'puestos' ? withoutComponents(oldRecord) : oldRecord;
        const newValue = collection.key === 'puestos' ? withoutComponents(record) : record;
        if (!isDeepStrictEqual(oldValue, newValue)) {
          changes.push({
            action: 'Actualizó',
            type: collection.label,
            name: recordName(record, collection.nameKeys),
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
        });
      }
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
      changes.push({ action: 'Agregó', type: 'componente de puesto', name });
    } else if (!isDeepStrictEqual(oldComponent, component)) {
      changes.push({ action: 'Actualizó', type: 'componente de puesto', name });
    }
  }
  for (const [id, component] of previousComponents) {
    if (!currentComponents.has(id)) {
      changes.push({
        action: 'Retiró',
        type: 'componente de puesto',
        name: recordName(component, ['tipo', 'marca']),
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
          const plural = group.count === 1 ? '' : 's';
          const examples = group.names.join(', ');
          const more = group.count > group.names.length ? ', …' : '';
          return `${group.action} ${group.count} ${group.type}${plural} (${examples}${more})`;
        })
        .join('; ')
        .slice(0, 500),
      details: { cambios: [...grouped.values()] },
    },
  ];
}

function mutationEvent(request: Request): OperatorAuditEvent {
  const path = request.path;
  const method = request.method;
  let action = `Realizó una acción (${method})`;
  let entityType = 'sistema';
  let entityId: string | null = null;

  if (path === '/admin/users' && method === 'POST') {
    action = 'Creó un usuario';
    entityType = 'usuario';
  } else if (/^\/admin\/users\/[^/]+\/password$/.test(path) && method === 'PUT') {
    action = 'Restableció una contraseña';
    entityType = 'usuario';
    entityId = path.split('/')[3] ?? null;
  } else if (path === '/tickets' && method === 'POST') {
    action = 'Creó un reclamo';
    entityType = 'reclamo';
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
  } else if (path === '/hardware-assets' && method === 'POST') {
    action = 'Registró un equipo patrimonial';
    entityType = 'equipo patrimonial';
  } else if (path === '/hardware-assets/import' && method === 'POST') {
    action = 'Importó equipos patrimoniales';
    entityType = 'equipo patrimonial';
  } else if (/^\/hardware-assets\/[^/]+\/patrimony$/.test(path) && method === 'PUT') {
    action = 'Actualizó un número patrimonial';
    entityType = 'equipo patrimonial';
    entityId = path.split('/')[2] ?? null;
  } else if (/^\/inventory\/puestos\/[^/]+\/componentes\/[^/]+$/.test(path) && method === 'PATCH') {
    action = 'Corrigió administrativamente un componente';
    entityType = 'componente';
    entityId = path.split('/').at(-1) ?? null;
  } else {
    entityType = path.split('/').filter(Boolean)[0] ?? 'sistema';
  }

  return { action, entityType, entityId, entityName: null, details: {} };
}

async function saveAuditEvents(
  pool: Pool,
  actor: SessionUser,
  events: OperatorAuditEvent[],
): Promise<void> {
  if (events.length === 0) return;
  await pool.query(
    `INSERT INTO gestion_it.operator_audit_events
       (actor_id, actor_username, action, entity_type, entity_id, entity_name, details)
     SELECT $1, $2, event.action, event.entity_type, event.entity_id,
            event.entity_name, event.details
     FROM jsonb_to_recordset($3::jsonb) AS event(
       action text, entity_type text, entity_id text, entity_name text, details jsonb
     )`,
    [actor.id, actor.username, JSON.stringify(events)],
  );
}

export function installOperatorAuditMiddleware(
  pool: Pool,
): (request: Request, response: Response, next: (error?: unknown) => void) => void {
  return (request, response, next) => {
    const actor = request.session.user;
    if (
      !actor ||
      (actor.role !== 'admin' && actor.role !== 'operator') ||
      ['GET', 'HEAD', 'OPTIONS'].includes(request.method) ||
      request.path.startsWith('/auth/')
    ) {
      next();
      return;
    }

    const isInventoryWrite =
      (request.path === '/inventory' && request.method === 'PUT') ||
      (request.path === '/inventory/import' && request.method === 'POST');

    if (!isInventoryWrite) {
      const event = mutationEvent(request);
      response.once('finish', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) return;
        void saveAuditEvents(pool, actor, [event]).catch((error: unknown) => {
          console.error('No se pudo guardar el registro de auditoría de operadores.', error);
        });
      });
      next();
      return;
    }

    void pool
      .query<{ payload: unknown }>(
        'SELECT payload FROM gestion_it.inventory_snapshot WHERE singleton_id = true',
      )
      .then((result) => {
        const beforeSnapshot = result.rows[0]?.payload;
        response.once('finish', () => {
          if (response.statusCode < 200 || response.statusCode >= 300) return;
          const events = describeInventoryChange(beforeSnapshot, request.body?.payload);
          void saveAuditEvents(pool, actor, events).catch((error: unknown) => {
            console.error('No se pudo guardar el registro de auditoría de operadores.', error);
          });
        });
        next();
      })
      .catch(next);
  };
}

import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import express, { type Request, type Response } from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import type { Pool, PoolClient } from 'pg';
import { hashPassword, verifyPassword } from './password';
import { requireRoles, type SessionUser, type SystemRole } from './session-user';
import {
  describeInventoryChange,
  excludeAuditedStockMovementHistory,
  installOperatorAuditMiddleware,
  inventoryHistoryAuditEvents,
  recordOperatorAuditEvents,
} from './operator-audit';
import { parseOptionalDate, parseOptionalText, parsePageOptions } from './list-query';
import { DEFAULT_SEDE_ID } from '../shared/locations';

export interface InventorySnapshot {
  pisos: Record<string, unknown>[];
  areas: unknown[];
  personas?: Record<string, unknown>[];
  stock: Record<string, unknown>[];
  puestos: Record<string, unknown>[];
  equiposRed: Record<string, unknown>[];
  componentesRetirados: unknown[];
  historial: unknown[];
}

interface StoredSnapshot {
  revision: string;
  payload: InventorySnapshot;
}

export interface ComponentEdit {
  tipo: string;
  marca: string;
  modelo?: string;
  especificacion: string;
  numeroSerie?: string;
  codigoSeguimiento?: string;
}

export interface StockShipmentRequest {
  expectedActorId: string;
  idempotencyKey: string;
  insumoId: string;
  destinoSedeId: string;
  cantidad: number;
  motivo: string;
}

export interface StockShipmentResult extends StoredSnapshot {
  idempotencyKey: string;
  movementId: string;
  alreadyProcessed: boolean;
}

export interface ManagedUserUpdate {
  role: SystemRole;
  areaId: string | null;
}

const externalTypes = new Set(['MONITOR', 'TECLADO', 'MOUSE', 'IMPRESORA', 'SCANNER']);
const peripheralTypes = new Set([
  ...externalTypes,
  'PROCESADOR',
  'RAM',
  'DISCO_HDD',
  'DISCO_SSD',
  'ALMACENAMIENTO',
  'GABINETE',
  'OTRO',
]);
const networkTypes = new Set(['SWITCH', 'ROUTER', 'AP']);
const emptySnapshot: InventorySnapshot = {
  pisos: [],
  areas: [],
  personas: [],
  stock: [],
  puestos: [],
  equiposRed: [],
  componentesRetirados: [],
  historial: [],
};
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseStockShipmentRequest(value: unknown): StockShipmentRequest | null {
  if (!isRecord(value)) return null;
  const expectedActorId = value['expectedActorId'];
  const idempotencyKey = value['idempotencyKey'];
  const insumoId = value['insumoId'];
  const destinoSedeId = value['destinoSedeId'];
  const cantidad = value['cantidad'];
  const motivo = typeof value['motivo'] === 'string' ? value['motivo'].trim() : '';
  if (
    typeof expectedActorId !== 'string' ||
    !uuidPattern.test(expectedActorId) ||
    typeof idempotencyKey !== 'string' ||
    !uuidPattern.test(idempotencyKey) ||
    typeof insumoId !== 'string' ||
    !insumoId.trim() ||
    insumoId.length > 200 ||
    typeof destinoSedeId !== 'string' ||
    !uuidPattern.test(destinoSedeId) ||
    !Number.isSafeInteger(cantidad) ||
    (cantidad as number) <= 0 ||
    (cantidad as number) > 1_000_000 ||
    !motivo ||
    motivo.length > 500
  ) {
    return null;
  }
  return {
    expectedActorId,
    idempotencyKey,
    insumoId: insumoId.trim(),
    destinoSedeId,
    cantidad: cantidad as number,
    motivo,
  };
}

function isInventorySnapshot(value: unknown): value is InventorySnapshot {
  if (!isRecord(value)) return false;
  const snapshot = value as Record<string, unknown>;
  const recordCollections = Object.keys(emptySnapshot).filter((key) => key !== 'personas');
  if (
    !recordCollections.every(
      (key) =>
        Array.isArray(snapshot[key]) &&
        (snapshot[key] as unknown[]).every(
          (item) => isRecord(item) && typeof item['id'] === 'string' && item['id'].length > 0,
        ),
    )
  ) {
    return false;
  }
  if (
    snapshot['personas'] !== undefined &&
    (!Array.isArray(snapshot['personas']) ||
      !(snapshot['personas'] as unknown[]).every(
        (item) => isRecord(item) && typeof item['id'] === 'string' && item['id'].length > 0,
      ))
  ) {
    return false;
  }

  const puestos = snapshot['puestos'] as Record<string, unknown>[];
  const stock = snapshot['stock'] as Record<string, unknown>[];
  const areas = snapshot['areas'] as Record<string, unknown>[];
  const equiposRed = snapshot['equiposRed'] as Record<string, unknown>[];
  const componentesRetirados = snapshot['componentesRetirados'] as Record<string, unknown>[];
  return (
    areas.every((area) => typeof area['nombre'] === 'string' && area['nombre'].trim().length > 0) &&
    puestos.every(
      (puesto) =>
        Array.isArray(puesto['componentes']) &&
        (puesto['componentes'] as unknown[]).every(
          (component) => isRecord(component) && typeof component['id'] === 'string',
        ),
    ) &&
    [
      ...stock,
      ...puestos.flatMap((puesto) => puesto['componentes'] as Record<string, unknown>[]),
    ].every((item) => typeof item['tipo'] === 'string' && peripheralTypes.has(item['tipo'])) &&
    equiposRed.every(
      (equipo) => typeof equipo['tipo'] === 'string' && networkTypes.has(equipo['tipo']),
    ) &&
    componentesRetirados.every((item) => isRecord(item['componente']))
  );
}

export function parseComponentEdit(value: unknown): ComponentEdit | null {
  if (!isRecord(value)) return null;
  const allowedFields = new Set([
    'tipo',
    'marca',
    'modelo',
    'especificacion',
    'numeroSerie',
    'codigoSeguimiento',
  ]);
  if (!Object.keys(value).every((key) => allowedFields.has(key))) return null;

  const tipo = value['tipo'];
  const marca = value['marca'];
  const modelo = value['modelo'] ?? '';
  const especificacion = value['especificacion'];
  const numeroSerie = value['numeroSerie'] ?? '';
  const codigoSeguimiento = value['codigoSeguimiento'] ?? '';
  if (
    typeof tipo !== 'string' ||
    !peripheralTypes.has(tipo) ||
    typeof marca !== 'string' ||
    !marca.trim() ||
    marca.trim().length > 120 ||
    typeof modelo !== 'string' ||
    modelo.trim().length > 120 ||
    typeof especificacion !== 'string' ||
    !especificacion.trim() ||
    especificacion.trim().length > 500 ||
    typeof numeroSerie !== 'string' ||
    numeroSerie.trim().length > 120 ||
    typeof codigoSeguimiento !== 'string' ||
    codigoSeguimiento.trim().length > 100
  ) {
    return null;
  }

  return {
    tipo,
    marca: marca.trim(),
    ...(modelo.trim() ? { modelo: modelo.trim() } : {}),
    especificacion: especificacion.trim(),
    ...(numeroSerie.trim() ? { numeroSerie: numeroSerie.trim() } : {}),
    ...(codigoSeguimiento.trim() ? { codigoSeguimiento: codigoSeguimiento.trim() } : {}),
  };
}

function componentesPorId(snapshot: InventorySnapshot): Map<string, Record<string, unknown>> {
  const componentes = new Map<string, Record<string, unknown>>();
  for (const puesto of snapshot.puestos) {
    if (!Array.isArray(puesto['componentes'])) continue;
    for (const value of puesto['componentes']) {
      if (isRecord(value) && typeof value['id'] === 'string') {
        componentes.set(value['id'], value);
      }
    }
  }
  for (const value of snapshot.componentesRetirados) {
    if (!isRecord(value) || !isRecord(value['componente'])) continue;
    const componente = value['componente'];
    if (typeof componente['id'] === 'string') {
      componentes.set(componente['id'], componente);
    }
  }
  return componentes;
}

export function areExistingComponentsUnchanged(
  current: InventorySnapshot,
  proposed: InventorySnapshot,
  allowRemoval = false,
): boolean {
  const proposedComponents = componentesPorId(proposed);
  for (const [id, component] of componentesPorId(current)) {
    const proposedComponent = proposedComponents.get(id);
    if (!proposedComponent) {
      if (allowRemoval) continue;
      return false;
    }
    if (!isDeepStrictEqual(component, proposedComponent)) return false;
  }
  return true;
}

async function syncInventoryAreas(client: PoolClient, snapshot: InventorySnapshot): Promise<void> {
  await client.query(
    'UPDATE gestion_it.areas SET activo = false WHERE inventory_area_id IS NOT NULL',
  );
  const floorLocations = new Map(
    snapshot.pisos.flatMap((value) =>
      isRecord(value) && typeof value['id'] === 'string'
        ? [[value['id'], String(value['sedeId'] ?? DEFAULT_SEDE_ID)] as const]
        : [],
    ),
  );
  for (const value of snapshot.areas) {
    if (
      !isRecord(value) ||
      typeof value['id'] !== 'string' ||
      typeof value['nombre'] !== 'string'
    ) {
      throw new Error('El inventario contiene un área inválida.');
    }
    await client.query(
      `INSERT INTO gestion_it.areas (id, nombre, inventory_area_id, sede_id, activo)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (inventory_area_id)
       DO UPDATE SET nombre = EXCLUDED.nombre, sede_id = EXCLUDED.sede_id, activo = true`,
      [
        randomUUID(),
        value['nombre'].trim(),
        value['id'],
        floorLocations.get(String(value['pisoId'])) ?? DEFAULT_SEDE_ID,
      ],
    );
  }
}

async function hasKnownInventorySedes(
  client: PoolClient,
  snapshot: InventorySnapshot,
): Promise<boolean> {
  const sedeIds = [
    ...snapshot.pisos.map((piso) => String(piso['sedeId'] ?? DEFAULT_SEDE_ID)),
    ...snapshot.stock.map((insumo) => String(insumo['sedeId'] ?? DEFAULT_SEDE_ID)),
  ];
  if (!sedeIds.every((id) => uuidPattern.test(id))) return false;
  const uniqueIds = [...new Set(sedeIds)];
  if (uniqueIds.length === 0) return true;
  const result = await client.query<{ id: string }>(
    'SELECT id::text FROM gestion_it.sedes WHERE id = ANY($1::uuid[])',
    [uniqueIds],
  );
  return result.rows.length === uniqueIds.length;
}

function ensureTrackingCode(value: unknown, prefix: string): string {
  const code = typeof value === 'string' ? value.trim() : '';
  return code || `${prefix}-${randomUUID().replaceAll('-', '').toUpperCase()}`;
}

export function areDelegationStockChangesValid(
  current: InventorySnapshot,
  proposed: InventorySnapshot,
): boolean {
  const previousById = new Map(current.stock.map((item) => [item['id'], item]));
  const existingHistoryIds = new Set(
    current.historial.flatMap((entry) =>
      isRecord(entry) && typeof entry['id'] === 'string' ? [entry['id']] : [],
    ),
  );
  const newHistory = proposed.historial.filter(
    (entry): entry is Record<string, unknown> =>
      isRecord(entry) && typeof entry['id'] === 'string' && !existingHistoryIds.has(entry['id']),
  );

  return proposed.stock.every((item) => {
    const sedeId = String(item['sedeId'] ?? DEFAULT_SEDE_ID);
    const previous = typeof item['id'] === 'string' ? previousById.get(item['id']) : undefined;
    if (!previous) return sedeId === DEFAULT_SEDE_ID;
    if (String(previous['sedeId'] ?? DEFAULT_SEDE_ID) !== sedeId) return false;
    if (sedeId === DEFAULT_SEDE_ID) return true;
    const oldQuantity = previous['cantidadDisponible'];
    const newQuantity = item['cantidadDisponible'];
    if (
      typeof oldQuantity !== 'number' ||
      !Number.isSafeInteger(oldQuantity) ||
      oldQuantity < 0 ||
      typeof newQuantity !== 'number' ||
      !Number.isSafeInteger(newQuantity) ||
      newQuantity < 0
    ) {
      return false;
    }
    if (newQuantity <= oldQuantity) return true;
    const difference = newQuantity - oldQuantity;
    return newHistory.some(
      (entry) =>
        entry['tipo'] === 'AJUSTE_STOCK' &&
        entry['insumoId'] === item['id'] &&
        entry['sedeId'] === sedeId &&
        entry['cantidad'] === difference,
    );
  });
}

export function normalizeSnapshot(snapshot: InventorySnapshot): InventorySnapshot {
  return {
    ...snapshot,
    pisos: snapshot.pisos.map((piso) => ({
      ...piso,
      sedeId:
        typeof piso['sedeId'] === 'string' && piso['sedeId'].trim()
          ? piso['sedeId']
          : DEFAULT_SEDE_ID,
    })),
    personas:
      snapshot.personas ??
      snapshot.puestos.flatMap((puesto) => {
        const name =
          typeof puesto['usuarioAsignado'] === 'string' ? puesto['usuarioAsignado'].trim() : '';
        const id = typeof puesto['id'] === 'string' ? puesto['id'] : '';
        const areaId = typeof puesto['areaId'] === 'string' ? puesto['areaId'] : '';
        return name && id && areaId
          ? [{ id: randomUUID(), nombre: name, areaId, puestoId: id }]
          : [];
      }),
    puestos: snapshot.puestos.map((puesto) => ({
      ...puesto,
      codigoSeguimiento: ensureTrackingCode(puesto['codigoSeguimiento'], 'PUESTO'),
      componentes: Array.isArray(puesto['componentes'])
        ? (puesto['componentes'] as Record<string, unknown>[]).map((componente) => {
            if (!externalTypes.has(String(componente['tipo']))) {
              const { codigoSeguimiento: _codigoSeguimiento, ...interno } = componente;
              return interno;
            }
            return {
              ...componente,
              codigoSeguimiento: ensureTrackingCode(componente['codigoSeguimiento'], 'COMP'),
            };
          })
        : [],
    })),
    stock: snapshot.stock.map((insumo) => {
      const withLocation = {
        ...insumo,
        sedeId:
          typeof insumo['sedeId'] === 'string' && insumo['sedeId'].trim()
            ? insumo['sedeId']
            : DEFAULT_SEDE_ID,
      };
      if (!externalTypes.has(String(insumo['tipo']))) {
        const { codigoSeguimiento: _codigoSeguimiento, ...interno } = insumo;
        return { ...interno, sedeId: withLocation.sedeId };
      }
      return {
        ...withLocation,
        codigoSeguimiento: ensureTrackingCode(insumo['codigoSeguimiento'], 'INS'),
      };
    }),
    equiposRed: snapshot.equiposRed.map((equipo) => ({
      ...equipo,
      codigoSeguimiento: ensureTrackingCode(equipo['codigoSeguimiento'], 'RED'),
    })),
  };
}

export class StockShipmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StockShipmentValidationError';
  }
}

export function applyStockShipment(
  original: InventorySnapshot,
  shipment: StockShipmentRequest,
  destinationName: string,
  actor: SessionUser,
  movementId = `hist-${randomUUID()}`,
): InventorySnapshot {
  if (
    !uuidPattern.test(shipment.destinoSedeId) ||
    shipment.destinoSedeId === DEFAULT_SEDE_ID ||
    !destinationName.trim()
  ) {
    throw new StockShipmentValidationError('El destino debe ser una delegación activa.');
  }
  if (
    !shipment.insumoId.trim() ||
    !Number.isSafeInteger(shipment.cantidad) ||
    shipment.cantidad <= 0 ||
    !shipment.motivo.trim() ||
    shipment.motivo.length > 500
  ) {
    throw new StockShipmentValidationError('Los datos de cantidad y motivo no son válidos.');
  }
  const snapshot = normalizeSnapshot(original);
  const source = snapshot.stock.find((item) => item['id'] === shipment.insumoId);
  if (!source)
    throw new StockShipmentValidationError('No se encontró el producto de Casa Central.');
  if (source['sedeId'] !== DEFAULT_SEDE_ID) {
    throw new StockShipmentValidationError('Solo se puede enviar stock que esté en Casa Central.');
  }
  const available = source['cantidadDisponible'];
  const minimum = source['stockMinimo'];
  if (
    typeof available !== 'number' ||
    !Number.isSafeInteger(available) ||
    available < shipment.cantidad
  ) {
    throw new StockShipmentValidationError(
      'La cantidad solicitada supera las existencias disponibles en Casa Central.',
    );
  }
  if (typeof minimum !== 'number' || !Number.isSafeInteger(minimum) || minimum < 0) {
    throw new StockShipmentValidationError('El stock mínimo del producto no es válido.');
  }

  const destinationItem = snapshot.stock.find(
    (item) =>
      item['tipo'] === source['tipo'] &&
      item['marca'] === source['marca'] &&
      item['especificacion'] === source['especificacion'] &&
      item['sedeId'] === shipment.destinoSedeId,
  );
  const destinationItemId =
    typeof destinationItem?.['id'] === 'string' ? destinationItem['id'] : `stk-${randomUUID()}`;
  const updatedStock = snapshot.stock.map((item) => {
    if (item['id'] === source['id']) {
      return { ...item, cantidadDisponible: available - shipment.cantidad };
    }
    if (item['id'] === destinationItemId && destinationItem) {
      const current = destinationItem['cantidadDisponible'];
      if (typeof current !== 'number' || !Number.isSafeInteger(current) || current < 0) {
        throw new StockShipmentValidationError(
          'El saldo del producto en la delegación no es válido.',
        );
      }
      const newBalance = current + shipment.cantidad;
      if (!Number.isSafeInteger(newBalance)) {
        throw new StockShipmentValidationError('El saldo resultante excede el límite permitido.');
      }
      return { ...item, cantidadDisponible: newBalance };
    }
    return item;
  });

  if (!destinationItem) {
    const { codigoSeguimiento: _codigoSeguimiento, ...sourceData } = source;
    updatedStock.push({
      ...sourceData,
      id: destinationItemId,
      cantidadDisponible: shipment.cantidad,
      stockMinimo: minimum,
      sedeId: shipment.destinoSedeId,
    });
  }

  const product = [source['tipo'], source['marca'], source['especificacion']]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join(' · ');
  const proposed = normalizeSnapshot({
    ...snapshot,
    stock: updatedStock,
    historial: [
      {
        id: movementId,
        fecha: new Date().toISOString(),
        tipo: 'TRANSFERENCIA_STOCK',
        cantidad: shipment.cantidad,
        detalle: `${shipment.cantidad} unidades de ${product} enviadas desde Casa Central a ${destinationName}. Motivo: ${shipment.motivo}`,
        sedeId: DEFAULT_SEDE_ID,
        sedeDestinoId: shipment.destinoSedeId,
        insumoId: shipment.insumoId,
        insumoDestinoId: destinationItemId,
      },
      ...snapshot.historial,
    ],
  });
  return attributeHistoryOperators(snapshot, proposed, actor);
}

export class StockShipmentIdempotencyConflictError extends Error {
  constructor() {
    super('La clave de idempotencia ya se utilizó con datos diferentes.');
    this.name = 'StockShipmentIdempotencyConflictError';
  }
}

export class StockShipmentActorMismatchError extends Error {
  constructor() {
    super('La sesión autenticada cambió desde que se confirmó el envío.');
    this.name = 'StockShipmentActorMismatchError';
  }
}

function stockShipmentFingerprint(shipment: StockShipmentRequest): string {
  const canonicalRequest = [
    shipment.insumoId,
    shipment.destinoSedeId.toLowerCase(),
    shipment.cantidad,
    shipment.motivo,
  ];
  return createHash('sha256').update(JSON.stringify(canonicalRequest)).digest('hex');
}

export async function executeStockShipment(
  pool: Pool,
  shipment: StockShipmentRequest,
  actor: SessionUser,
): Promise<StockShipmentResult> {
  if (shipment.expectedActorId !== actor.id) throw new StockShipmentActorMismatchError();
  const client = await pool.connect();
  let transactionStarted = false;
  const fingerprint = stockShipmentFingerprint(shipment);
  const movementId = `hist-${randomUUID()}`;

  try {
    await client.query('BEGIN');
    transactionStarted = true;
    const claim = await client.query<{ idempotency_key: string }>(
      `INSERT INTO gestion_it.inventory_stock_shipments
         (idempotency_key, actor_id, request_fingerprint, insumo_id, destino_sede_id,
          cantidad, motivo, movement_id)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6, $7, $8)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING idempotency_key::text`,
      [
        shipment.idempotencyKey,
        actor.id,
        fingerprint,
        shipment.insumoId,
        shipment.destinoSedeId,
        shipment.cantidad,
        shipment.motivo,
        movementId,
      ],
    );

    if (!claim.rows[0]) {
      const existing = await client.query<{
        actor_id: string;
        request_fingerprint: string;
        movement_id: string;
        processed_revision: string | null;
      }>(
        `SELECT actor_id::text, request_fingerprint, movement_id, processed_revision::text
         FROM gestion_it.inventory_stock_shipments
         WHERE idempotency_key = $1::uuid`,
        [shipment.idempotencyKey],
      );
      const previous = existing.rows[0];
      if (!previous) throw new Error('No se pudo recuperar el resultado del envío previo.');
      if (previous.actor_id !== actor.id || previous.request_fingerprint !== fingerprint) {
        throw new StockShipmentIdempotencyConflictError();
      }
      if (!previous.processed_revision) {
        throw new Error('El registro de idempotencia del envío está incompleto.');
      }

      const current = await client.query<StoredSnapshot>(
        'SELECT revision::text, payload FROM gestion_it.inventory_snapshot WHERE singleton_id = true',
      );
      const row = current.rows[0];
      if (!row) throw new Error('No existe el estado inicial del inventario.');
      await recordOperatorAuditEvents(client, actor, [
        {
          action: 'Reintentó un envío de stock ya procesado',
          entityType: 'reintento de envío de stock',
          entityId: previous.movement_id,
          entityName: 'Reintento idempotente',
          details: {
            idempotencyKey: shipment.idempotencyKey,
            movementId: previous.movement_id,
            resultado: 'ya_procesado',
          },
        },
      ]);
      await client.query('COMMIT');
      transactionStarted = false;
      return {
        ...row,
        idempotencyKey: shipment.idempotencyKey,
        movementId: previous.movement_id,
        alreadyProcessed: true,
      };
    }

    const current = await client.query<StoredSnapshot>(
      'SELECT revision::text, payload FROM gestion_it.inventory_snapshot WHERE singleton_id = true FOR UPDATE',
    );
    const row = current.rows[0];
    if (!row) throw new Error('No existe el estado inicial del inventario.');

    const destination = await client.query<{ nombre: string }>(
      `SELECT nombre
       FROM gestion_it.sedes
       WHERE id = $1::uuid AND tipo = 'DELEGACION' AND activa = true
       FOR SHARE`,
      [shipment.destinoSedeId],
    );
    const destinationName = destination.rows[0]?.nombre;
    if (!destinationName) {
      throw new StockShipmentValidationError(
        'Seleccioná una delegación activa como destino del envío.',
      );
    }

    const payload = applyStockShipment(row.payload, shipment, destinationName, actor, movementId);
    if (!(await hasKnownInventorySedes(client, payload))) {
      throw new StockShipmentValidationError('El inventario contiene una sede inválida.');
    }
    if (!hasUniqueTrackingCodes(payload)) {
      throw new StockShipmentValidationError(
        'El envío produciría códigos de seguimiento duplicados.',
      );
    }

    const saved = await client.query<StoredSnapshot>(
      `UPDATE gestion_it.inventory_snapshot
       SET payload = $1::jsonb, revision = revision + 1, updated_at = now()
       WHERE singleton_id = true
       RETURNING revision::text, payload`,
      [JSON.stringify(payload)],
    );
    const result = saved.rows[0];
    if (!result) throw new Error('No se pudo recuperar el inventario actualizado.');
    await client.query(
      `UPDATE gestion_it.inventory_stock_shipments
       SET processed_revision = $2::bigint
       WHERE idempotency_key = $1::uuid`,
      [shipment.idempotencyKey, result.revision],
    );
    await recordOperatorAuditEvents(client, actor, [
      {
        action: 'Envió stock desde Casa Central a una delegación',
        entityType: 'transferencia de stock',
        entityId: movementId,
        entityName: `${shipment.cantidad} unidades a ${destinationName}`,
        details: {
          idempotencyKey: shipment.idempotencyKey,
          movementId,
          insumoId: shipment.insumoId,
          destinoSedeId: shipment.destinoSedeId,
          cantidad: shipment.cantidad,
          motivo: shipment.motivo,
          resultado: 'procesado',
        },
      },
    ]);
    await client.query('COMMIT');
    transactionStarted = false;
    return {
      ...result,
      idempotencyKey: shipment.idempotencyKey,
      movementId,
      alreadyProcessed: false,
    };
  } catch (error: unknown) {
    if (transactionStarted) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function attributeHistoryOperators(
  current: InventorySnapshot,
  proposed: InventorySnapshot,
  actor: SessionUser,
): InventorySnapshot {
  const previousById = new Map(
    current.historial.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry['id'] !== 'string') return [];
      return [[entry['id'], entry] as const];
    }),
  );

  return {
    ...proposed,
    historial: proposed.historial.map((entry) => {
      if (!isRecord(entry) || typeof entry['id'] !== 'string') return entry;

      const { operador: _operador, operadorId: _operadorId, ...values } = entry;
      const previous = previousById.get(entry['id']);
      if (!previous) {
        return { ...values, operadorId: actor.id, operador: actor.username };
      }

      return {
        ...values,
        ...(typeof previous['operadorId'] === 'string'
          ? { operadorId: previous['operadorId'] }
          : {}),
        ...(typeof previous['operador'] === 'string' ? { operador: previous['operador'] } : {}),
      };
    }),
  };
}

function hasUniqueTrackingCodes(snapshot: InventorySnapshot): boolean {
  const codes = [
    ...snapshot.puestos.map((puesto) => String(puesto['codigoSeguimiento'])),
    ...snapshot.equiposRed.map((equipo) => String(equipo['codigoSeguimiento'])),
    ...snapshot.stock.flatMap((item) =>
      item['codigoSeguimiento'] ? [String(item['codigoSeguimiento'])] : [],
    ),
    ...snapshot.puestos.flatMap((puesto) =>
      Array.isArray(puesto['componentes'])
        ? (puesto['componentes'] as Record<string, unknown>[]).flatMap((item) =>
            item['codigoSeguimiento'] ? [String(item['codigoSeguimiento'])] : [],
          )
        : [],
    ),
  ];
  return new Set(codes).size === codes.length;
}

const requireUser = requireRoles(['admin', 'operator', 'solicitante', 'dashboard']);
const requireInventoryViewer = requireRoles(['admin', 'operator', 'dashboard']);
const requireInventoryEditor = requireRoles(['admin', 'operator']);
const requireAdministrator = requireRoles(['admin']);

function isSystemRole(value: unknown): value is SystemRole {
  return (
    value === 'admin' || value === 'operator' || value === 'solicitante' || value === 'dashboard'
  );
}

export function parsePasswordReset(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const password = (value as Record<string, unknown>)['password'];
  return typeof password === 'string' && password.length >= 12 ? password : null;
}

export function parseManagedUserUpdate(value: unknown): ManagedUserUpdate | null {
  if (!isRecord(value) || !isSystemRole(value['role'])) return null;

  const rawAreaId = value['areaId'];
  if (value['role'] === 'solicitante') {
    return typeof rawAreaId === 'string' && uuidPattern.test(rawAreaId)
      ? { role: value['role'], areaId: rawAreaId }
      : null;
  }
  if (rawAreaId !== undefined && rawAreaId !== null) return null;
  return { role: value['role'], areaId: null };
}

export function createLoginFailureKey(ipAddress: string, username: string): string {
  return JSON.stringify([ipAddress, username.trim().toLowerCase()]);
}

function isAdmin(request: Request): boolean {
  return request.session.user?.role === 'admin';
}

function establishSession(
  request: Request,
  response: Response,
  user: SessionUser,
  next: express.NextFunction,
  status = 200,
): void {
  request.session.regenerate((error) => {
    if (error) {
      next(error);
      return;
    }
    request.session.user = user;
    request.session.save((saveError) => {
      if (saveError) {
        next(saveError);
        return;
      }
      response.status(status).json({ user });
    });
  });
}

export function createInventoryApi(pool: Pool, sessionSecret: string): express.Router {
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET debe tener al menos 32 caracteres.');
  }

  const router = express.Router();
  const PgSessionStore = connectPgSimple(session);
  router.use(
    session({
      store: new PgSessionStore({
        pool,
        schemaName: 'gestion_it',
        tableName: 'sessions',
        createTableIfMissing: false,
      }),
      name: 'gestion_it.sid',
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'strict',
        secure: process.env['COOKIE_SECURE'] === 'true',
        maxAge: 8 * 60 * 60 * 1000,
      },
    }),
  );

  router.use((request, response, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      next();
      return;
    }
    const origin = request.get('origin');
    if (origin && new URL(origin).host !== request.get('host')) {
      response.status(403).json({ error: 'Origen de solicitud no permitido.' });
      return;
    }
    next();
  });

  router.use(installOperatorAuditMiddleware(pool));

  router.get('/health', async (_request, response, next) => {
    try {
      await pool.query('SELECT 1');
      response.json({ status: 'ok' });
    } catch (error) {
      next(error);
    }
  });

  router.get('/auth/session', async (request, response, next) => {
    try {
      const result = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM gestion_it.app_users',
      );
      response.json({
        authenticated: !!request.session.user,
        user: request.session.user ?? null,
        setupRequired: result.rows[0]?.count === '0',
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/auth/setup', async (request, response, next) => {
    const username = typeof request.body?.username === 'string' ? request.body.username.trim() : '';
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    if (!/^[a-zA-Z0-9._-]{3,64}$/.test(username) || password.length < 12) {
      response
        .status(400)
        .json({ error: 'Ingresá un usuario válido y una contraseña de al menos 12 caracteres.' });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(80421917)');
      const users = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM gestion_it.app_users',
      );
      if (users.rows[0]?.count !== '0') {
        await client.query('ROLLBACK');
        response.status(409).json({ error: 'La configuración inicial ya fue completada.' });
        return;
      }

      const user: SessionUser = {
        id: randomUUID(),
        username,
        role: 'admin',
        areaId: null,
        areaNombre: null,
      };
      const passwordHash = await hashPassword(password);
      await client.query(
        'INSERT INTO gestion_it.app_users (id, username, password_hash, role, area_id) VALUES ($1, $2, $3, $4, $5)',
        [user.id, username, passwordHash, user.role, user.areaId],
      );
      await client.query('COMMIT');
      establishSession(request, response, user, next, 201);
    } catch (error) {
      await client.query('ROLLBACK');
      next(error);
    } finally {
      client.release();
    }
  });

  const loginFailures = new Map<string, { attempts: number; resetAt: number }>();
  const getLoginFailureKey = (request: Request): string => {
    const ipAddress = request.ip ?? request.socket.remoteAddress ?? 'unknown';
    const username = typeof request.body?.username === 'string' ? request.body.username : '';
    return createLoginFailureKey(ipAddress, username);
  };
  const registerLoginFailure = (key: string): void => {
    if (!loginFailures.has(key) && loginFailures.size >= 10_000) {
      const oldestKey = loginFailures.keys().next().value;
      if (oldestKey) loginFailures.delete(oldestKey);
    }
    const current = loginFailures.get(key);
    loginFailures.set(key, {
      attempts: (current?.attempts ?? 0) + 1,
      resetAt: current?.resetAt ?? Date.now() + 15 * 60 * 1000,
    });
  };
  router.post(
    '/auth/login',
    (request, response, next) => {
      const now = Date.now();
      const key = getLoginFailureKey(request);
      const current = loginFailures.get(key);
      if (current && current.resetAt > now && current.attempts >= 10) {
        response.status(429).json({
          error:
            'Demasiados intentos para esta cuenta desde esta red. Esperá 15 minutos antes de volver a intentar.',
        });
        return;
      }
      if (!current || current.resetAt <= now) {
        loginFailures.set(key, { attempts: 0, resetAt: now + 15 * 60 * 1000 });
      }
      next();
    },
    async (request, response, next) => {
      const username =
        typeof request.body?.username === 'string' ? request.body.username.trim() : '';
      const password = typeof request.body?.password === 'string' ? request.body.password : '';
      try {
        const result = await pool.query<{
          id: string;
          username: string;
          password_hash: string;
          role: SystemRole;
          area_id: string | null;
          area_nombre: string | null;
        }>(
          `SELECT u.id, u.username, u.password_hash, u.role, u.area_id, a.nombre AS area_nombre
         FROM gestion_it.app_users AS u
         LEFT JOIN gestion_it.areas AS a ON a.id = u.area_id
         WHERE u.username = $1`,
          [username],
        );
        const record = result.rows[0];
        if (!record || !(await verifyPassword(password, record.password_hash))) {
          const key = getLoginFailureKey(request);
          registerLoginFailure(key);
          response.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
          return;
        }
        loginFailures.delete(getLoginFailureKey(request));
        const user: SessionUser = {
          id: record.id,
          username: record.username,
          role: record.role,
          areaId: record.area_id,
          areaNombre: record.area_nombre,
        };
        establishSession(request, response, user, next);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post('/auth/logout', requireUser, (request, response, next) => {
    request.session.destroy((error) => {
      if (error) {
        next(error);
        return;
      }
      response.clearCookie('gestion_it.sid');
      response.status(204).end();
    });
  });

  router.get('/inventory', requireInventoryViewer, async (_request, response, next) => {
    try {
      const result = await pool.query<StoredSnapshot>(
        'SELECT revision::text, payload FROM gestion_it.inventory_snapshot WHERE singleton_id = true',
      );
      const row = result.rows[0];
      if (!row) throw new Error('No existe el estado inicial del inventario.');
      response.json(row);
    } catch (error) {
      next(error);
    }
  });

  router.post(
    '/inventory/stock-transfers',
    requireInventoryEditor,
    async (request, response, next) => {
      const shipment = parseStockShipmentRequest(request.body);
      if (!shipment) {
        response.status(400).json({
          code: 'INVALID_SHIPMENT_REQUEST',
          error: 'Los datos del envío de stock son inválidos.',
        });
        return;
      }
      const actor = request.session.user;
      if (!actor) {
        response.status(401).json({ error: 'Iniciá sesión para continuar.' });
        return;
      }

      try {
        const result = await executeStockShipment(pool, shipment, actor);
        response.locals['stockShipmentAudit'] = {
          idempotencyKey: result.idempotencyKey,
          movementId: result.movementId,
          alreadyProcessed: result.alreadyProcessed,
        };
        response.locals['operatorAuditRecordedTransactionally'] = true;
        response.json(result);
      } catch (error) {
        if (error instanceof StockShipmentActorMismatchError) {
          response.status(409).json({
            code: 'OPERATOR_SESSION_CHANGED',
            error: error.message,
          });
          return;
        }
        if (error instanceof StockShipmentIdempotencyConflictError) {
          response.status(409).json({
            code: 'IDEMPOTENCY_KEY_REUSED',
            error: error.message,
          });
          return;
        }
        if (error instanceof StockShipmentValidationError) {
          response.status(400).json({
            code: 'SHIPMENT_REJECTED',
            error: error.message,
          });
          return;
        }
        next(error);
      }
    },
  );

  router.put('/inventory', requireInventoryEditor, async (request, response, next) => {
    const { revision, payload } = request.body ?? {};
    if (!Number.isSafeInteger(revision) || !isInventorySnapshot(payload)) {
      response.status(400).json({ error: 'El respaldo del inventario tiene un formato inválido.' });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<StoredSnapshot>(
        'SELECT revision::text, payload FROM gestion_it.inventory_snapshot WHERE singleton_id = true FOR UPDATE',
      );
      const currentRow = current.rows[0];
      if (!currentRow) throw new Error('No existe el estado inicial del inventario.');
      if (Number(currentRow.revision) !== revision) {
        await client.query('ROLLBACK');
        response.status(409).json({
          error:
            'Otro usuario modificó el inventario. Se recargaron los datos más recientes; volvé a intentar la operación.',
          revision: currentRow.revision,
          payload: currentRow.payload,
        });
        return;
      }

      const admin = isAdmin(request);
      if (!areExistingComponentsUnchanged(currentRow.payload, payload, admin)) {
        await client.query('ROLLBACK');
        response.status(admin ? 400 : 403).json({
          error: admin
            ? 'Para editar los datos de un componente, usá la edición administrativa del componente.'
            : 'Solo una persona administradora puede editar o eliminar componentes existentes.',
        });
        return;
      }

      if (!areDelegationStockChangesValid(currentRow.payload, payload)) {
        await client.query('ROLLBACK');
        response.status(400).json({
          error:
            'Los ingresos a delegaciones deben registrarse como envíos desde Casa Central; solo se permiten ajustes de saldo con motivo.',
        });
        return;
      }

      const actor = request.session.user;
      if (!actor) {
        response.status(401).json({ error: 'Iniciá sesión para continuar.' });
        return;
      }

      const normalized = attributeHistoryOperators(
        currentRow.payload,
        normalizeSnapshot(payload),
        actor,
      );
      if (!(await hasKnownInventorySedes(client, normalized))) {
        await client.query('ROLLBACK');
        response.status(400).json({ error: 'El inventario contiene una sede inválida.' });
        return;
      }
      if (!hasUniqueTrackingCodes(normalized)) {
        response
          .status(400)
          .json({ error: 'El inventario contiene códigos de seguimiento duplicados.' });
        await client.query('ROLLBACK');
        return;
      }

      const saved = await client.query<StoredSnapshot>(
        `UPDATE gestion_it.inventory_snapshot
         SET payload = $1::jsonb, revision = revision + 1, updated_at = now()
         WHERE singleton_id = true
         RETURNING revision::text, payload`,
        [JSON.stringify(normalized)],
      );
      await syncInventoryAreas(client, normalized);
      const auditEvents = describeInventoryChange(currentRow.payload, normalized);
      await recordOperatorAuditEvents(
        client,
        actor,
        auditEvents.length > 0
          ? auditEvents.map((event) => ({
              ...event,
              details: { ...event.details, resultado: 'exitoso' },
            }))
          : [
              {
                action: 'Guardó el inventario sin cambios',
                entityType: 'inventario',
                entityId: null,
                entityName: null,
                details: { resultado: 'exitoso', cambios: [] },
              },
            ],
      );
      await client.query('COMMIT');
      response.locals['operatorAuditRecordedTransactionally'] = true;
      response.json(saved.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      next(error);
    } finally {
      client.release();
    }
  });

  router.patch(
    '/inventory/puestos/:puestoId/componentes/:componenteId',
    requireAdministrator,
    async (request, response, next) => {
      const { revision, changes, reason } = request.body ?? {};
      const edit = parseComponentEdit(changes);
      const motivo = typeof reason === 'string' ? reason.trim() : '';
      if (!Number.isSafeInteger(revision) || !edit || !motivo || motivo.length > 500) {
        response.status(400).json({ error: 'Los datos de edición del componente son inválidos.' });
        return;
      }

      const actor = request.session.user;
      if (!actor) {
        response.status(401).json({ error: 'Iniciá sesión para continuar.' });
        return;
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const current = await client.query<StoredSnapshot>(
          'SELECT revision::text, payload FROM gestion_it.inventory_snapshot WHERE singleton_id = true FOR UPDATE',
        );
        const currentRow = current.rows[0];
        if (!currentRow) throw new Error('No existe el estado inicial del inventario.');
        if (Number(currentRow.revision) !== revision) {
          await client.query('ROLLBACK');
          response.status(409).json({
            error:
              'Otro usuario modificó el inventario. Se recargaron los datos más recientes; volvé a intentar la operación.',
            revision: currentRow.revision,
            payload: currentRow.payload,
          });
          return;
        }

        const puestoId = request.params['puestoId'];
        const componenteId = request.params['componenteId'];
        if (typeof puestoId !== 'string' || typeof componenteId !== 'string') {
          await client.query('ROLLBACK');
          response.status(404).json({ error: 'No se encontró el componente en ese puesto.' });
          return;
        }
        const puesto = currentRow.payload.puestos.find((item) => item['id'] === puestoId);
        const componente =
          puesto && Array.isArray(puesto['componentes'])
            ? (puesto['componentes'] as unknown[]).find(
                (item) => isRecord(item) && item['id'] === componenteId,
              )
            : undefined;
        if (!puesto || !isRecord(componente)) {
          await client.query('ROLLBACK');
          response.status(404).json({ error: 'No se encontró el componente en ese puesto.' });
          return;
        }

        const before = { ...componente };
        const after = { id: componente['id'], ...edit };
        const proposed: InventorySnapshot = {
          ...currentRow.payload,
          puestos: currentRow.payload.puestos.map((item) =>
            item['id'] === puestoId
              ? {
                  ...item,
                  componentes: (item['componentes'] as unknown[]).map((value) =>
                    isRecord(value) && value['id'] === componenteId ? after : value,
                  ),
                }
              : item,
          ),
        };
        const normalized = normalizeSnapshot(proposed);
        if (!hasUniqueTrackingCodes(normalized)) {
          await client.query('ROLLBACK');
          response.status(400).json({
            error: 'El código de seguimiento ya está asignado a otro elemento.',
          });
          return;
        }

        const updatedPuesto = normalized.puestos.find((item) => item['id'] === puestoId);
        const updatedComponent =
          updatedPuesto && Array.isArray(updatedPuesto['componentes'])
            ? (updatedPuesto['componentes'] as Record<string, unknown>[]).find(
                (item) => item['id'] === componenteId,
              )
            : undefined;
        if (!updatedComponent) throw new Error('No se pudo actualizar el componente.');

        const beforeData = { ...before };
        delete beforeData['id'];
        const afterData = { ...updatedComponent };
        delete afterData['id'];
        if (isDeepStrictEqual(beforeData, afterData)) {
          await client.query('ROLLBACK');
          response.status(400).json({ error: 'No hay cambios para guardar en el componente.' });
          return;
        }

        const saved = await client.query<StoredSnapshot>(
          `UPDATE gestion_it.inventory_snapshot
           SET payload = $1::jsonb, revision = revision + 1, updated_at = now()
           WHERE singleton_id = true
           RETURNING revision::text, payload`,
          [JSON.stringify(normalized)],
        );
        await client.query(
          `INSERT INTO gestion_it.inventory_component_edits
             (component_id, puesto_id, changed_by, changed_by_username, reason, before_data, after_data)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
          [
            componenteId,
            puestoId,
            actor.id,
            actor.username,
            motivo,
            JSON.stringify(beforeData),
            JSON.stringify(afterData),
          ],
        );
        await recordOperatorAuditEvents(client, actor, [
          {
            action: 'Corrigió administrativamente un componente',
            entityType: 'componente',
            entityId: componenteId,
            entityName: `${String(updatedComponent['tipo'] ?? '')} ${String(updatedComponent['marca'] ?? '')}`.trim(),
            details: {
              resultado: 'exitoso',
              puestoId,
              motivo,
              anterior: beforeData,
              posterior: afterData,
            },
          },
        ]);
        await client.query('COMMIT');
        response.locals['operatorAuditRecordedTransactionally'] = true;
        response.json(saved.rows[0]);
      } catch (error) {
        await client.query('ROLLBACK');
        next(error);
      } finally {
        client.release();
      }
    },
  );

  router.post('/inventory/import', requireUser, async (request, response, next) => {
    if (!isAdmin(request)) {
      response
        .status(403)
        .json({ error: 'Solo una persona administradora puede importar un respaldo.' });
      return;
    }
    const actor = request.session.user;
    if (!actor) {
      response.status(401).json({ error: 'Iniciá sesión para continuar.' });
      return;
    }
    const { payload } = request.body ?? {};
    if (!isInventorySnapshot(payload)) {
      response
        .status(400)
        .json({ error: 'El archivo no contiene un respaldo de inventario válido.' });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<{ revision: string; payload: InventorySnapshot }>(
        'SELECT revision::text, payload FROM gestion_it.inventory_snapshot WHERE singleton_id = true FOR UPDATE',
      );
      const row = current.rows[0];
      if (!row) throw new Error('No existe el estado inicial del inventario.');
      const empty = Object.values(row.payload).every((collection) => collection.length === 0);
      if (!empty) {
        await client.query('ROLLBACK');
        response.status(409).json({
          error: 'La importación solo se permite cuando el inventario del servidor está vacío.',
        });
        return;
      }
      const normalized = normalizeSnapshot(payload);
      if (!(await hasKnownInventorySedes(client, normalized))) {
        await client.query('ROLLBACK');
        response.status(400).json({ error: 'El respaldo contiene una sede inválida.' });
        return;
      }
      if (!hasUniqueTrackingCodes(normalized)) {
        await client.query('ROLLBACK');
        response
          .status(400)
          .json({ error: 'El respaldo contiene códigos de seguimiento duplicados.' });
        return;
      }
      const saved = await client.query<StoredSnapshot>(
        `UPDATE gestion_it.inventory_snapshot
         SET payload = $1::jsonb, revision = revision + 1, updated_at = now()
         WHERE singleton_id = true
         RETURNING revision::text, payload`,
        [JSON.stringify(normalized)],
      );
      await syncInventoryAreas(client, normalized);
      const auditEvents = describeInventoryChange(row.payload, normalized);
      await recordOperatorAuditEvents(
        client,
        actor,
        auditEvents.length > 0
          ? auditEvents.map((event) => ({
              ...event,
              details: { ...event.details, resultado: 'exitoso', tipo: 'importacion' },
            }))
          : [
              {
                action: 'Importó un inventario sin elementos',
                entityType: 'inventario',
                entityId: null,
                entityName: null,
                details: { resultado: 'exitoso', tipo: 'importacion', cambios: [] },
              },
            ],
      );
      await client.query('COMMIT');
      response.locals['operatorAuditRecordedTransactionally'] = true;
      response.json(saved.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      next(error);
    } finally {
      client.release();
    }
  });

  router.get('/admin/areas', requireAdministrator, async (_request, response, next) => {
    try {
      const result = await pool.query(
        `SELECT area.id, area.nombre, sede.nombre AS "sedeNombre"
         FROM gestion_it.areas AS area
         JOIN gestion_it.sedes AS sede ON sede.id = area.sede_id
         WHERE area.activo = true
         ORDER BY sede.nombre, area.nombre`,
      );
      response.json(result.rows);
    } catch (error) {
      next(error);
    }
  });

  router.get('/admin/users', requireAdministrator, async (_request, response, next) => {
    try {
      const result = await pool.query(
        `SELECT u.id, u.username, u.role, u.area_id AS "areaId",
                a.nombre AS "areaNombre", sede.nombre AS "sedeNombre",
                u.created_at AS "createdAt"
         FROM gestion_it.app_users AS u
         LEFT JOIN gestion_it.areas AS a ON a.id = u.area_id
         LEFT JOIN gestion_it.sedes AS sede ON sede.id = a.sede_id
         ORDER BY u.username`,
      );
      response.json(result.rows);
    } catch (error) {
      next(error);
    }
  });

  router.get('/admin/operator-audit', requireAdministrator, async (request, response, next) => {
    const from = parseOptionalDate(request.query['from']);
    const to = parseOptionalDate(request.query['to']);
    const rawActorId = request.query['actorId'];
    const actorId = typeof rawActorId === 'string' ? rawActorId : null;
    const module = parseOptionalText(request.query['module'], 100);
    const action = parseOptionalText(request.query['action'], 120);
    const search = parseOptionalText(request.query['search'], 200);
    const sort = parseOptionalText(request.query['sort'], 16);
    const pagination = parsePageOptions(
      request.query['page'],
      request.query['pageSize'],
      500,
      500,
    );
    if (
      from === undefined ||
      to === undefined ||
      module === undefined ||
      action === undefined ||
      search === undefined ||
      sort === undefined ||
      pagination === null ||
      (from !== null && to !== null && from > to) ||
      (rawActorId !== undefined && typeof rawActorId !== 'string') ||
      (actorId !== null && !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(actorId)) ||
      (sort !== null && sort !== 'newest' && sort !== 'oldest')
    ) {
      response.status(400).json({ error: 'Los filtros de auditoría no son válidos.' });
      return;
    }

    const values: unknown[] = [];
    const filters: string[] = [];
    const bind = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };
    if (from) filters.push(`event.created_at >= ${bind(from)}::date`);
    if (to) filters.push(`event.created_at < ${bind(to)}::date + interval '1 day'`);
    let actorParam: string | null = null;
    if (actorId) {
      actorParam = bind(actorId);
      filters.push(`event.actor_id = ${actorParam}::uuid`);
    }
    if (module) filters.push(`event.entity_type ILIKE '%' || ${bind(module)} || '%'`);
    if (action) filters.push(`event.action ILIKE '%' || ${bind(action)} || '%'`);
    if (search) {
      const term = bind(search);
      filters.push(
        `(event.actor_username ILIKE '%' || ${term} || '%'
          OR event.action ILIKE '%' || ${term} || '%'
          OR event.entity_type ILIKE '%' || ${term} || '%'
          OR COALESCE(event.entity_id, '') ILIKE '%' || ${term} || '%'
          OR COALESCE(event.entity_name, '') ILIKE '%' || ${term} || '%'
          OR event.details::text ILIKE '%' || ${term} || '%')`,
      );
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    const joinFilters = filters.length > 0
      ? `AND ${filters.join(' AND ').replaceAll('event.', 'e.')}`
      : '';
    const order = sort === 'oldest' ? 'ASC' : 'DESC';

    try {
      const [operators, summary, count, inventory, firstAuditEvent] = await Promise.all([
        pool.query<{ id: string; username: string; role: string }>(
          `SELECT id, username, role
           FROM gestion_it.app_users
           WHERE role IN ('admin', 'operator', 'solicitante', 'dashboard')
           ORDER BY username`,
        ),
        pool.query<{
          actorId: string;
          username: string;
          role: string;
          eventCount: number;
        }>(
          `SELECT u.id AS "actorId", u.username, u.role,
                  count(e.id)::int AS "eventCount"
           FROM gestion_it.app_users AS u
           LEFT JOIN gestion_it.operator_audit_events AS e
             ON e.actor_id = u.id ${joinFilters}
           WHERE u.role IN ('admin', 'operator', 'solicitante', 'dashboard')
             ${actorParam ? `AND u.id = ${actorParam}::uuid` : ''}
           GROUP BY u.id, u.username, u.role
           ORDER BY count(e.id) DESC, u.username`,
          values,
        ),
        pool.query<{ total: number }>(
          `SELECT count(*)::int AS total
           FROM gestion_it.operator_audit_events AS event
           ${where}`,
          values,
        ),
        pool.query<{ history: unknown }>(
          `SELECT payload->'historial' AS history
           FROM gestion_it.inventory_snapshot
           WHERE singleton_id = true`,
        ),
        pool.query<{ first_created_at: Date | null }>(
          'SELECT min(created_at) AS first_created_at FROM gestion_it.operator_audit_events',
        ),
      ]);
      const auditStartedAt = firstAuditEvent.rows[0]?.first_created_at?.toISOString() ?? null;
      const filteredHistoryEvents = inventoryHistoryAuditEvents(inventory.rows[0]?.history).filter(
        (event) =>
          (!auditStartedAt || event.createdAt < auditStartedAt) &&
          (!from || event.createdAt.slice(0, 10) >= from) &&
          (!to || event.createdAt.slice(0, 10) <= to) &&
          (!actorId || event.actorId === actorId) &&
          (!module || event.entityType.toLocaleLowerCase().includes(module.toLocaleLowerCase())) &&
          (!action || event.action.toLocaleLowerCase().includes(action.toLocaleLowerCase())) &&
          (!search ||
            [
              event.actorUsername,
              event.action,
              event.entityType,
              event.entityId ?? '',
              event.entityName ?? '',
              JSON.stringify(event.details),
            ]
              .join(' ')
              .toLocaleLowerCase()
              .includes(search.toLocaleLowerCase())),
      );
      const historyEvents = await excludeAuditedStockMovementHistory(
        pool,
        filteredHistoryEvents,
      );
      const fallbackCounts = new Map<string, number>();
      for (const event of historyEvents) {
        fallbackCounts.set(event.actorId, (fallbackCounts.get(event.actorId) ?? 0) + 1);
      }
      historyEvents.sort((left, right) => {
        const comparison = left.createdAt.localeCompare(right.createdAt);
        if (comparison !== 0) return order === 'ASC' ? comparison : -comparison;
        return order === 'ASC'
          ? left.id.localeCompare(right.id)
          : right.id.localeCompare(left.id);
      });

      const databaseTotal = count.rows[0]?.total ?? 0;
      const historyTotal = historyEvents.length;
      const total = databaseTotal + historyTotal;
      const offset = pagination.offset;
      let databaseOffset = 0;
      let databaseLimit = 0;
      let historyOffset = 0;
      let historyLimit = 0;
      if (order === 'DESC') {
        if (offset < databaseTotal) {
          databaseOffset = offset;
          databaseLimit = Math.min(pagination.pageSize, databaseTotal - offset);
          historyLimit = pagination.pageSize - databaseLimit;
        } else {
          historyOffset = offset - databaseTotal;
          historyLimit = pagination.pageSize;
        }
      } else if (offset < historyTotal) {
        historyOffset = offset;
        historyLimit = Math.min(pagination.pageSize, historyTotal - offset);
        databaseLimit = pagination.pageSize - historyLimit;
      } else {
        databaseOffset = offset - historyTotal;
        databaseLimit = pagination.pageSize;
      }

      const databaseEvents =
        databaseLimit > 0 && databaseOffset < databaseTotal
          ? await pool.query(
              `SELECT id, actor_id AS "actorId", actor_username AS "actorUsername",
                      action, entity_type AS "entityType", entity_id AS "entityId",
                      entity_name AS "entityName", details, created_at AS "createdAt"
               FROM gestion_it.operator_audit_events AS event
               ${where}
               ORDER BY event.created_at ${order}, event.id ${order}
               LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
              [...values, databaseLimit, databaseOffset],
            )
          : { rows: [] };
      const legacyEvents = historyEvents.slice(historyOffset, historyOffset + historyLimit);
      const summaryWithHistory = summary.rows.map((operator) => ({
        ...operator,
        eventCount: operator.eventCount + (fallbackCounts.get(operator.actorId) ?? 0),
      }));
      const pageEvents = [...databaseEvents.rows, ...legacyEvents].sort((left, right) => {
        const leftTime = new Date(left.createdAt).getTime();
        const rightTime = new Date(right.createdAt).getTime();
        const comparison = leftTime - rightTime;
        if (comparison !== 0) return order === 'ASC' ? comparison : -comparison;
        return order === 'ASC'
          ? String(left.id).localeCompare(String(right.id))
          : String(right.id).localeCompare(String(left.id));
      });
      response.json({
        operators: operators.rows,
        summary: summaryWithHistory,
        events: pageEvents,
        total,
        page: pagination.page,
        pageSize: pagination.pageSize,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/admin/users', requireAdministrator, async (request, response, next) => {
    const username = typeof request.body?.username === 'string' ? request.body.username.trim() : '';
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    const roleValue: unknown = request.body?.role;
    const role = isSystemRole(roleValue) ? roleValue : null;
    const areaId =
      typeof request.body?.areaId === 'string' ? request.body.areaId.trim() || null : null;
    if (
      !/^[a-zA-Z0-9._-]{3,64}$/.test(username) ||
      password.length < 12 ||
      !role ||
      (role === 'solicitante' && !areaId)
    ) {
      response.status(400).json({
        error:
          'Ingresá usuario, contraseña, rol válido y asigná un área a las cuentas solicitantes.',
      });
      return;
    }
    try {
      const passwordHash = await hashPassword(password);
      const result = await pool.query(
        `INSERT INTO gestion_it.app_users (id, username, password_hash, role, area_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, username, role, area_id AS "areaId", created_at AS "createdAt"`,
        [randomUUID(), username, passwordHash, role, areaId],
      );
      const created = result.rows[0];
      if (created) {
        response.locals['operatorAuditContext'] = {
          entityId: created.id,
          entityName: created.username,
          details: { role: created.role, areaId: created.areaId },
        };
      }
      response.status(201).json(created);
    } catch (error) {
      if (typeof error === 'object' && error && 'code' in error && error.code === '23503') {
        response.status(400).json({ error: 'El área seleccionada no existe.' });
        return;
      }
      if (typeof error === 'object' && error && 'code' in error && error.code === '23505') {
        response.status(409).json({ error: 'Ya existe una cuenta con ese usuario.' });
        return;
      }
      next(error);
    }
  });

  router.patch('/admin/users/:id', requireAdministrator, async (request, response, next) => {
    const update = parseManagedUserUpdate(request.body);
    if (!update) {
      response.status(400).json({
        error: 'Seleccioná un rol válido y asigná un área activa a las cuentas solicitantes.',
      });
      return;
    }

    const userId = request.params['id'];
    if (typeof userId !== 'string' || !uuidPattern.test(userId)) {
      response.status(400).json({ error: 'El identificador de usuario no es válido.' });
      return;
    }
    if (request.session.user?.id === userId) {
      response.status(409).json({ error: 'No podés editar tu propia cuenta desde esta pantalla.' });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('gestion_it:admin-user-update'))`);
      const current = await client.query<{
        id: string;
        role: SystemRole;
        area_id: string | null;
      }>(
        `SELECT id, role, area_id
         FROM gestion_it.app_users
         WHERE id = $1
         FOR UPDATE`,
        [userId],
      );
      const existing = current.rows[0];
      if (!existing) {
        await client.query('ROLLBACK');
        response.status(404).json({ error: 'No se encontró el usuario.' });
        return;
      }

      if (update.areaId) {
        const area = await client.query(
          `SELECT id
           FROM gestion_it.areas
           WHERE id = $1 AND activo = true
           FOR SHARE`,
          [update.areaId],
        );
        if (!area.rows[0]) {
          await client.query('ROLLBACK');
          response.status(400).json({ error: 'El área seleccionada no existe o está inactiva.' });
          return;
        }
      }

      if (existing.role === 'admin' && update.role !== 'admin') {
        const administrators = await client.query(
          `SELECT id
           FROM gestion_it.app_users
           WHERE role = 'admin'
           FOR UPDATE`,
        );
        if (administrators.rows.length <= 1) {
          await client.query('ROLLBACK');
          response.status(409).json({ error: 'Debe quedar al menos una cuenta administradora.' });
          return;
        }
      }

      const changed = existing.role !== update.role || existing.area_id !== update.areaId;
      if (changed) {
        await client.query(
          `UPDATE gestion_it.app_users
           SET role = $2, area_id = $3
           WHERE id = $1`,
          [userId, update.role, update.areaId],
        );
        await client.query(
          `DELETE FROM gestion_it.sessions
           WHERE sess -> 'user' ->> 'id' = $1`,
          [userId],
        );
      }

      await client.query('COMMIT');
      const result = await pool.query(
        `SELECT u.id, u.username, u.role, u.area_id AS "areaId",
                a.nombre AS "areaNombre", sede.nombre AS "sedeNombre",
                u.created_at AS "createdAt"
         FROM gestion_it.app_users AS u
         LEFT JOIN gestion_it.areas AS a ON a.id = u.area_id
         LEFT JOIN gestion_it.sedes AS sede ON sede.id = a.sede_id
         WHERE u.id = $1`,
        [userId],
      );
      response.json(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      next(error);
    } finally {
      client.release();
    }
  });

  router.put('/admin/users/:id/password', requireAdministrator, async (request, response, next) => {
    const password = parsePasswordReset(request.body);
    if (!password) {
      response
        .status(400)
        .json({ error: 'La nueva contraseña debe tener al menos 12 caracteres.' });
      return;
    }

    const userId = request.params['id'];
    if (typeof userId !== 'string' || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(userId)) {
      response.status(400).json({ error: 'El identificador de usuario no es válido.' });
      return;
    }

    try {
      const passwordHash = await hashPassword(password);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const updated = await client.query(
          `UPDATE gestion_it.app_users
           SET password_hash = $2
           WHERE id = $1
           RETURNING id`,
          [userId, passwordHash],
        );
        if (!updated.rows[0]) {
          await client.query('ROLLBACK');
          response.status(404).json({ error: 'No se encontró el usuario.' });
          return;
        }

        await client.query(
          `DELETE FROM gestion_it.sessions
           WHERE sess -> 'user' ->> 'id' = $1 AND sid <> $2`,
          [userId, request.sessionID],
        );
        await client.query('COMMIT');
        response.json({
          message: 'Se restableció la contraseña y se cerraron las otras sesiones.',
        });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  });

  router.use(
    (error: unknown, _request: Request, response: Response, _next: express.NextFunction) => {
      console.error('Error en la API de Gestión IT:', error);
      response.status(500).json({ error: 'Ocurrió un error interno al procesar la solicitud.' });
    },
  );

  return router;
}

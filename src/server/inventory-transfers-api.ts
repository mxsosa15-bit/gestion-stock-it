import { randomUUID } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { normalizeSnapshot, type InventorySnapshot } from './inventory-api';
import { requireRoles } from './session-user';

type EntityType = 'AREA' | 'PERSONA' | 'COMPONENTE' | 'EQUIPO_RED';

export interface TransferRequest {
  revision: number;
  origenAreaId: string;
  destinoAreaId: string | null;
  destinoPuestoId: string | null;
  nuevoPuesto: { nombrePuesto: string } | null;
  personaIds: string[];
  componentes: { puestoId: string; componenteId: string }[];
  equipoRedIds: string[];
  moverAreaCompleta: boolean;
  destinoPisoId: string | null;
  descripcion: string;
}

interface TransferMovement {
  tipoEntidad: EntityType;
  entidadId: string;
  nombreEntidad: string;
  origen: Record<string, string | null>;
  destino: Record<string, string | null>;
}

interface TransferResult {
  snapshot: InventorySnapshot;
  movimientos: TransferMovement[];
  origenPisoId: string;
  destinoPisoId: string;
}

export class TransferValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransferValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseStringList(value: unknown): string[] | null {
  if (
    !Array.isArray(value) ||
    value.length > 200 ||
    !value.every(nonEmptyString) ||
    new Set(value).size !== value.length
  ) {
    return null;
  }
  return value.map((item) => item.trim());
}

export function parseTransferRequest(value: unknown): TransferRequest | null {
  if (!isRecord(value)) return null;
  const revision = value['revision'];
  const originAreaId = value['origenAreaId'];
  const destinationAreaId = value['destinoAreaId'];
  const destinationWorkstationId = value['destinoPuestoId'];
  const fullArea = value['moverAreaCompleta'];
  const destinationFloorId = value['destinoPisoId'];
  const description =
    typeof value['descripcion'] === 'string' ? value['descripcion'].trim() : '';
  const personIds = parseStringList(value['personaIds']);
  const networkIds = parseStringList(value['equipoRedIds']);
  const rawComponents = value['componentes'];
  const rawNewWorkstation = value['nuevoPuesto'];
  let newWorkstation: TransferRequest['nuevoPuesto'] = null;

  if (rawNewWorkstation !== null && rawNewWorkstation !== undefined) {
    if (!isRecord(rawNewWorkstation) || !nonEmptyString(rawNewWorkstation['nombrePuesto'])) {
      return null;
    }
    const name = rawNewWorkstation['nombrePuesto'].trim();
    if (name.length > 200) return null;
    newWorkstation = { nombrePuesto: name };
  }

  if (
    !Number.isSafeInteger(revision) ||
    (revision as number) < 0 ||
    !nonEmptyString(originAreaId) ||
    (destinationAreaId !== null && !nonEmptyString(destinationAreaId)) ||
    (destinationWorkstationId !== null && !nonEmptyString(destinationWorkstationId)) ||
    typeof fullArea !== 'boolean' ||
    (destinationFloorId !== null && !nonEmptyString(destinationFloorId)) ||
    description.length < 1 ||
    description.length > 1_000 ||
    !personIds ||
    !networkIds ||
    !Array.isArray(rawComponents) ||
    rawComponents.length > 200
  ) {
    return null;
  }

  const components: TransferRequest['componentes'] = [];
  for (const rawComponent of rawComponents) {
    if (
      !isRecord(rawComponent) ||
      !nonEmptyString(rawComponent['puestoId']) ||
      !nonEmptyString(rawComponent['componenteId'])
    ) {
      return null;
    }
    components.push({
      puestoId: rawComponent['puestoId'].trim(),
      componenteId: rawComponent['componenteId'].trim(),
    });
  }
  const componentKeys = components.map((item) => `${item.puestoId}\u0000${item.componenteId}`);
  if (new Set(componentKeys).size !== componentKeys.length) return null;

  return {
    revision: revision as number,
    origenAreaId: originAreaId.trim(),
    destinoAreaId:
      typeof destinationAreaId === 'string' ? destinationAreaId.trim() : null,
    destinoPuestoId:
      typeof destinationWorkstationId === 'string' ? destinationWorkstationId.trim() : null,
    nuevoPuesto: newWorkstation,
    personaIds: personIds,
    componentes: components,
    equipoRedIds: networkIds,
    moverAreaCompleta: fullArea,
    destinoPisoId: typeof destinationFloorId === 'string' ? destinationFloorId.trim() : null,
    descripcion: description,
  };
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TransferValidationError(`El registro de ${label} no es válido.`);
  return value;
}

function readString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new TransferValidationError(`No se pudo identificar ${label}.`);
  }
  return value;
}

function readCollection(snapshot: InventorySnapshot, key: string): Record<string, unknown>[] {
  const value = snapshot[key as keyof InventorySnapshot];
  if (!Array.isArray(value)) throw new TransferValidationError('El inventario no es válido.');
  return value.map((item) => readRecord(item, key));
}

function findById(
  collection: Record<string, unknown>[],
  id: string,
  label: string,
): Record<string, unknown> {
  const found = collection.find((item) => item['id'] === id);
  if (!found) throw new TransferValidationError(`No se encontró ${label}.`);
  return found;
}

function location(
  areaId: string,
  floorId: string,
  workstationId: string | null = null,
): Record<string, string | null> {
  return { areaId, floorId, workstationId };
}

function createMovement(
  type: EntityType,
  id: string,
  name: string,
  origin: Record<string, string | null>,
  destination: Record<string, string | null>,
): TransferMovement {
  return { tipoEntidad: type, entidadId: id, nombreEntidad: name, origen: origin, destino: destination };
}

function assertAreaFloor(area: Record<string, unknown>, label: string): string {
  const floorId = area['pisoId'];
  if (!nonEmptyString(floorId)) {
    throw new TransferValidationError(`${label} no tiene un piso válido asignado.`);
  }
  return floorId;
}

export function applyInventoryTransfer(
  original: InventorySnapshot,
  transfer: TransferRequest,
): TransferResult {
  const snapshot = structuredClone(normalizeSnapshot(original));
  const areas = readCollection(snapshot, 'areas');
  const floors = readCollection(snapshot, 'pisos');
  const workstations = readCollection(snapshot, 'puestos');
  const persons = readCollection(snapshot, 'personas');
  const networks = readCollection(snapshot, 'equiposRed');
  const originArea = findById(areas, transfer.origenAreaId, 'el área de origen');
  const originFloorId = assertAreaFloor(originArea, 'El área de origen');
  const movements: TransferMovement[] = [];

  if (transfer.moverAreaCompleta) {
    if (
      transfer.destinoPisoId === null ||
      transfer.destinoAreaId !== transfer.origenAreaId ||
      transfer.personaIds.length > 0 ||
      transfer.componentes.length > 0 ||
      transfer.equipoRedIds.length > 0 ||
      transfer.destinoPuestoId !== null ||
      transfer.nuevoPuesto !== null
    ) {
      throw new TransferValidationError('La mudanza completa de área requiere seleccionar solo un piso destino.');
    }
    const destinationFloor = findById(floors, transfer.destinoPisoId, 'el piso de destino');
    const destinationFloorId = readString(destinationFloor, 'id', 'el piso de destino');
    if (destinationFloorId === originFloorId) {
      throw new TransferValidationError('El área ya está asignada a ese piso.');
    }
    const areaId = readString(originArea, 'id', 'el área de origen');
    const areaName = readString(originArea, 'nombre', 'el área');
    originArea['pisoId'] = destinationFloorId;
    movements.push(
      createMovement(
        'AREA',
        areaId,
        areaName,
        { areaId, floorId: originFloorId },
        { areaId, floorId: destinationFloorId },
      ),
    );

    for (const person of persons.filter((item) => item['areaId'] === areaId)) {
      const workstationId = String(person['puestoId'] ?? '');
      movements.push(
        createMovement(
          'PERSONA',
          String(person['id']),
          String(person['nombre']),
          location(areaId, originFloorId, workstationId || null),
          location(areaId, destinationFloorId, workstationId || null),
        ),
      );
    }
    for (const workstation of workstations.filter((item) => item['areaId'] === areaId)) {
      const workstationId = readString(workstation, 'id', 'el puesto');
      const components = readCollectionFromWorkstation(workstation);
      for (const component of components) {
        movements.push(
          createMovement(
            'COMPONENTE',
            String(component['id']),
            componentName(component),
            location(areaId, originFloorId, workstationId),
            location(areaId, destinationFloorId, workstationId),
          ),
        );
      }
    }
    for (const network of networks.filter((item) => item['areaId'] === areaId)) {
      movements.push(
        createMovement(
          'EQUIPO_RED',
          String(network['id']),
          `${String(network['tipo'] ?? 'Equipo de red')} ${String(network['marca'] ?? '')} ${String(network['modelo'] ?? '')}`.trim(),
          location(areaId, originFloorId),
          location(areaId, destinationFloorId),
        ),
      );
    }
    return {
      snapshot,
      movimientos: movements,
      origenPisoId: originFloorId,
      destinoPisoId: destinationFloorId,
    };
  }

  if (transfer.destinoAreaId === null || transfer.destinoAreaId === transfer.origenAreaId) {
    throw new TransferValidationError('Seleccioná un área de destino distinta del origen.');
  }
  if (transfer.destinoPisoId !== null) {
    throw new TransferValidationError('Elegí una mudanza de área completa para cambiar de piso.');
  }
  const destinationArea = findById(areas, transfer.destinoAreaId, 'el área de destino');
  const destinationFloorId = assertAreaFloor(destinationArea, 'El área de destino');
  if (transfer.personaIds.length + transfer.componentes.length + transfer.equipoRedIds.length === 0) {
    throw new TransferValidationError('Seleccioná al menos una persona o un activo para transferir.');
  }
  if (transfer.personaIds.length > 1) {
    throw new TransferValidationError('Transferí una persona por operación para asignar correctamente su nuevo puesto.');
  }
  if (transfer.destinoPuestoId && transfer.nuevoPuesto) {
    throw new TransferValidationError('Elegí un puesto existente o creá uno nuevo, no ambos.');
  }
  if (
    (transfer.personaIds.length > 0 || transfer.componentes.length > 0) &&
    !transfer.destinoPuestoId &&
    !transfer.nuevoPuesto
  ) {
    throw new TransferValidationError('Elegí un puesto de destino o creá uno nuevo para la persona o el equipo.');
  }

  let destinationWorkstation: Record<string, unknown> | null = null;
  if (transfer.destinoPuestoId) {
    destinationWorkstation = findById(workstations, transfer.destinoPuestoId, 'el puesto de destino');
    if (destinationWorkstation['areaId'] !== transfer.destinoAreaId) {
      throw new TransferValidationError('El puesto de destino no pertenece al área seleccionada.');
    }
  } else if (transfer.nuevoPuesto) {
    destinationWorkstation = {
      id: randomUUID(),
      areaId: transfer.destinoAreaId,
      nombrePuesto: transfer.nuevoPuesto.nombrePuesto,
      usuarioAsignado: '',
      codigoSeguimiento: '',
      componentes: [],
    };
    workstations.push(destinationWorkstation);
  }
  const destinationWorkstationId =
    destinationWorkstation && typeof destinationWorkstation['id'] === 'string'
      ? destinationWorkstation['id']
      : null;

  let movingPerson: Record<string, unknown> | null = null;
  if (transfer.personaIds.length) {
    movingPerson = findById(persons, transfer.personaIds[0]!, 'la persona seleccionada');
    if (movingPerson['areaId'] !== transfer.origenAreaId) {
      throw new TransferValidationError('La persona seleccionada ya no pertenece al área de origen.');
    }
    if (!destinationWorkstation || destinationWorkstation['usuarioAsignado'] !== '') {
      throw new TransferValidationError('El puesto de destino ya tiene una persona asignada.');
    }
    const personName = readString(movingPerson, 'nombre', 'la persona seleccionada');
    const rawSourceWorkstationId = movingPerson['puestoId'];
    let sourceWorkstationId: string | null = null;
    if (rawSourceWorkstationId !== null) {
      if (!nonEmptyString(rawSourceWorkstationId)) {
        throw new TransferValidationError('El puesto actual de la persona no es válido.');
      }
      sourceWorkstationId = rawSourceWorkstationId;
      const sourceWorkstation = findById(workstations, sourceWorkstationId, 'el puesto de origen');
      if (sourceWorkstation['areaId'] !== transfer.origenAreaId) {
        throw new TransferValidationError('El puesto de origen no pertenece al área seleccionada.');
      }
      if (sourceWorkstation['usuarioAsignado'] !== personName) {
        throw new TransferValidationError(
          'La asignación del usuario cambió; actualizá el inventario antes de continuar.',
        );
      }
      sourceWorkstation['usuarioAsignado'] = '';
    }
    const source = location(transfer.origenAreaId, originFloorId, sourceWorkstationId);
    const destination = location(transfer.destinoAreaId, destinationFloorId, destinationWorkstationId);
    movements.push(createMovement('PERSONA', String(movingPerson['id']), personName, source, destination));
    destinationWorkstation['usuarioAsignado'] = personName;
    movingPerson['areaId'] = transfer.destinoAreaId;
    movingPerson['puestoId'] = destinationWorkstationId;
  }

  for (const item of transfer.componentes) {
    const sourceWorkstation = findById(workstations, item.puestoId, 'el puesto que contiene el activo');
    if (sourceWorkstation['areaId'] !== transfer.origenAreaId) {
      throw new TransferValidationError('Uno de los equipos seleccionados ya no pertenece al área de origen.');
    }
    const components = readCollectionFromWorkstation(sourceWorkstation);
    const componentIndex = components.findIndex((component) => component['id'] === item.componenteId);
    if (componentIndex < 0) {
      throw new TransferValidationError('Uno de los equipos seleccionados ya no está en el puesto de origen.');
    }
    const [component] = components.splice(componentIndex, 1);
    if (!component) throw new TransferValidationError('No se pudo retirar el equipo del puesto de origen.');
    if (!destinationWorkstation || !destinationWorkstationId) {
      throw new TransferValidationError('Falta el puesto de destino del equipo.');
    }
    const originWorkstationId = readString(sourceWorkstation, 'id', 'el puesto de origen');
    const name = componentName(component);
    movements.push(
      createMovement(
        'COMPONENTE',
        String(component['id']),
        name,
        location(transfer.origenAreaId, originFloorId, originWorkstationId),
        location(transfer.destinoAreaId, destinationFloorId, destinationWorkstationId),
      ),
    );
    const targetComponents = readCollectionFromWorkstation(destinationWorkstation);
    targetComponents.push(component);
    destinationWorkstation['componentes'] = targetComponents;
    sourceWorkstation['componentes'] = components;
  }

  for (const networkId of transfer.equipoRedIds) {
    const network = findById(networks, networkId, 'el equipo de red seleccionado');
    if (network['areaId'] !== transfer.origenAreaId) {
      throw new TransferValidationError('Uno de los equipos de red ya no pertenece al área de origen.');
    }
    const name = `${String(network['tipo'] ?? 'Equipo de red')} ${String(network['marca'] ?? '')} ${String(network['modelo'] ?? '')}`.trim();
    movements.push(
      createMovement(
        'EQUIPO_RED',
        networkId,
        name,
        location(transfer.origenAreaId, originFloorId),
        location(transfer.destinoAreaId, destinationFloorId),
      ),
    );
    network['areaId'] = transfer.destinoAreaId;
  }

  return {
    snapshot,
    movimientos: movements,
    origenPisoId: originFloorId,
    destinoPisoId: destinationFloorId,
  };
}

function readCollectionFromWorkstation(
  workstation: Record<string, unknown>,
): Record<string, unknown>[] {
  const components = workstation['componentes'];
  if (!Array.isArray(components) || !components.every(isRecord)) {
    throw new TransferValidationError('La lista de equipos del puesto no es válida.');
  }
  return components;
}

function componentName(component: Record<string, unknown>): string {
  return [
    component['tipo'],
    component['marca'],
    component['modelo'],
    component['especificacion'],
  ]
    .filter((part) => typeof part === 'string' && part.trim())
    .join(' · ');
}

export function createInventoryTransfersApi(pool: Pool): express.Router {
  const router = express.Router();
  const requireOperator = requireRoles(['admin', 'operator']);

  router.get('/transferencias', requireOperator, async (_request, response, next) => {
    try {
      const result = await pool.query(
        `SELECT transfer.id,
                transfer.description AS descripcion,
                transfer.created_at AS "creadoAt",
                actor.username AS "creadoPor",
                COALESCE(
                  jsonb_agg(
                    jsonb_build_object(
                      'id', movement.id,
                      'tipoEntidad', movement.entity_type,
                      'entidadId', movement.entity_id,
                      'nombreEntidad', movement.entity_name,
                      'origen', movement.origin,
                      'destino', movement.destination
                    ) ORDER BY movement.created_at, movement.id
                  ) FILTER (WHERE movement.id IS NOT NULL),
                  '[]'::jsonb
                ) AS movimientos
         FROM gestion_it.inventory_transfers AS transfer
         JOIN gestion_it.app_users AS actor ON actor.id = transfer.created_by
         LEFT JOIN gestion_it.inventory_transfer_movements AS movement
           ON movement.transfer_id = transfer.id
         GROUP BY transfer.id, actor.username
         ORDER BY transfer.created_at DESC, transfer.id DESC
         LIMIT 100`,
      );
      response.json(
        result.rows.map((row) => ({
          id: row['id'],
          descripcion: row['descripcion'],
          creadoAt: row['creadoAt'],
          creadoPor: row['creadoPor'],
          movimientos: row['movimientos'],
        })),
      );
    } catch (error) {
      next(error);
    }
  });

  router.post('/transferencias', requireOperator, async (request, response, next) => {
    const transfer = parseTransferRequest(request.body);
    if (!transfer) {
      response.status(400).json({ error: 'Los datos de la transferencia son inválidos.' });
      return;
    }
    const actor = request.session.user;
    if (!actor) {
      response.status(401).json({ error: 'Iniciá sesión para continuar.' });
      return;
    }

    const client = await pool.connect();
    let transactionStarted = false;
    try {
      await client.query('BEGIN');
      transactionStarted = true;
      const current = await client.query<{ revision: string; payload: InventorySnapshot }>(
        `SELECT revision::text, payload
         FROM gestion_it.inventory_snapshot
         WHERE singleton_id = true
         FOR UPDATE`,
      );
      const row = current.rows[0];
      if (!row) throw new Error('No existe el estado inicial del inventario.');
      if (Number(row.revision) !== transfer.revision) {
        await client.query('ROLLBACK');
        transactionStarted = false;
        response.status(409).json({
          error: 'El inventario cambió desde que abriste Transferencias. Se actualizaron los datos; revisá la selección.',
          revision: row.revision,
          payload: row.payload,
        });
        return;
      }

      const result = applyInventoryTransfer(row.payload, transfer);
      const transferId = randomUUID();
      await client.query(
        `INSERT INTO gestion_it.inventory_transfers
           (id, created_by, description, origin_area_id, destination_area_id,
            origin_floor_id, destination_floor_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          transferId,
          actor.id,
          transfer.descripcion,
          transfer.origenAreaId,
          transfer.moverAreaCompleta ? transfer.origenAreaId : transfer.destinoAreaId,
          result.origenPisoId,
          result.destinoPisoId,
        ],
      );
      for (const movement of result.movimientos) {
        await client.query(
          `INSERT INTO gestion_it.inventory_transfer_movements
             (transfer_id, entity_type, entity_id, entity_name, origin, destination)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
          [
            transferId,
            movement.tipoEntidad,
            movement.entidadId,
            movement.nombreEntidad,
            JSON.stringify(movement.origen),
            JSON.stringify(movement.destino),
          ],
        );
      }
      const saved = await client.query<{ revision: string; payload: InventorySnapshot }>(
        `UPDATE gestion_it.inventory_snapshot
         SET payload = $1::jsonb, revision = revision + 1, updated_at = now()
         WHERE singleton_id = true
         RETURNING revision::text, payload`,
        [JSON.stringify(result.snapshot)],
      );
      const savedSnapshot = saved.rows[0];
      if (!savedSnapshot) throw new Error('No se pudo recuperar el inventario transferido.');
      await client.query('COMMIT');
      transactionStarted = false;
      response.status(201).json({
        transferenciaId: transferId,
        revision: savedSnapshot.revision,
        payload: savedSnapshot.payload,
      });
    } catch (error) {
      if (transactionStarted) await client.query('ROLLBACK');
      if (error instanceof TransferValidationError) {
        response.status(400).json({ error: error.message });
        return;
      }
      next(error);
    } finally {
      client.release();
    }
  });

  router.use(
    (error: unknown, _request: Request, response: Response, next: express.NextFunction) => {
      if (response.headersSent) {
        next(error);
        return;
      }
      console.error('Error en la API de transferencias:', error);
      response.status(500).json({ error: 'Ocurrió un error interno al procesar la transferencia.' });
    },
  );
  return router;
}

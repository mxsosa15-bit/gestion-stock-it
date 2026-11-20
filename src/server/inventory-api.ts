import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import express, { type Request, type Response } from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import type { Pool, PoolClient } from 'pg';
import { hashPassword, verifyPassword } from './password';
import { requireRoles, type SessionUser, type SystemRole } from './session-user';
import { installOperatorAuditMiddleware, inventoryHistoryAuditEvents } from './operator-audit';
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
  insumoId: string;
  destinoSedeId: string;
  cantidad: number;
  motivo: string;
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
  const insumoId = value['insumoId'];
  const destinoSedeId = value['destinoSedeId'];
  const cantidad = value['cantidad'];
  const motivo = typeof value['motivo'] === 'string' ? value['motivo'].trim() : '';
  if (
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
  return { insumoId: insumoId.trim(), destinoSedeId, cantidad: cantidad as number, motivo };
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
        id: `hist-${randomUUID()}`,
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
        response.status(400).json({ error: 'Los datos del envío de stock son inválidos.' });
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
          await client.query('ROLLBACK');
          transactionStarted = false;
          response.status(400).json({
            error: 'Seleccioná una delegación activa como destino del envío.',
          });
          return;
        }

        const payload = applyStockShipment(row.payload, shipment, destinationName, actor);
        if (!(await hasKnownInventorySedes(client, payload))) {
          await client.query('ROLLBACK');
          transactionStarted = false;
          response.status(400).json({ error: 'El inventario contiene una sede inválida.' });
          return;
        }
        if (!hasUniqueTrackingCodes(payload)) {
          await client.query('ROLLBACK');
          transactionStarted = false;
          response.status(400).json({
            error: 'El envío produciría códigos de seguimiento duplicados.',
          });
          return;
        }

        const saved = await client.query<StoredSnapshot>(
          `UPDATE gestion_it.inventory_snapshot
         SET payload = $1::jsonb, revision = revision + 1, updated_at = now()
         WHERE singleton_id = true
         RETURNING revision::text, payload`,
          [JSON.stringify(payload)],
        );
        await client.query('COMMIT');
        transactionStarted = false;
        response.json(saved.rows[0]);
      } catch (error) {
        if (transactionStarted) await client.query('ROLLBACK');
        if (error instanceof StockShipmentValidationError) {
          response.status(400).json({ error: error.message });
          return;
        }
        next(error);
      } finally {
        client.release();
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
      await client.query('COMMIT');
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
        await client.query('COMMIT');
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
      await client.query('COMMIT');
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
    const from = typeof request.query['from'] === 'string' ? request.query['from'] : null;
    const to = typeof request.query['to'] === 'string' ? request.query['to'] : null;
    const actorId = typeof request.query['actorId'] === 'string' ? request.query['actorId'] : null;
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    const isValidDate = (value: string | null): boolean =>
      value === null ||
      (datePattern.test(value) &&
        !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) &&
        new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value);
    if (
      !isValidDate(from) ||
      !isValidDate(to) ||
      (from !== null && to !== null && from > to) ||
      (actorId !== null && !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(actorId))
    ) {
      response.status(400).json({ error: 'Los filtros de auditoría no son válidos.' });
      return;
    }

    try {
      const [operators, summary, events, inventory] = await Promise.all([
        pool.query<{ id: string; username: string; role: string }>(
          `SELECT id, username, role
           FROM gestion_it.app_users
           WHERE role IN ('admin', 'operator')
           ORDER BY username`,
        ),
        pool.query<{
          actorId: string;
          username: string;
          role: string;
          taskCount: number;
        }>(
          `SELECT u.id AS "actorId", u.username, u.role,
                  count(e.id)::int AS "taskCount"
           FROM gestion_it.app_users AS u
           LEFT JOIN gestion_it.operator_audit_events AS e
             ON e.actor_id = u.id
            AND ($1::date IS NULL OR e.created_at >= $1::date)
            AND ($2::date IS NULL OR e.created_at < $2::date + interval '1 day')
            AND ($3::uuid IS NULL OR e.actor_id = $3::uuid)
           WHERE u.role IN ('admin', 'operator')
             AND ($3::uuid IS NULL OR u.id = $3::uuid)
           GROUP BY u.id, u.username, u.role
           ORDER BY count(e.id) DESC, u.username`,
          [from, to, actorId],
        ),
        pool.query(
          `SELECT id, actor_id AS "actorId", actor_username AS "actorUsername",
                  action, entity_type AS "entityType", entity_id AS "entityId",
                  entity_name AS "entityName", details, created_at AS "createdAt"
           FROM gestion_it.operator_audit_events
           WHERE ($1::date IS NULL OR created_at >= $1::date)
             AND ($2::date IS NULL OR created_at < $2::date + interval '1 day')
             AND ($3::uuid IS NULL OR actor_id = $3::uuid)
           ORDER BY created_at DESC, id DESC
           LIMIT 500`,
          [from, to, actorId],
        ),
        pool.query<{ history: unknown }>(
          `SELECT payload->'historial' AS history
           FROM gestion_it.inventory_snapshot
           WHERE singleton_id = true`,
        ),
      ]);
      const historyEvents = inventoryHistoryAuditEvents(inventory.rows[0]?.history).filter(
        (event) =>
          (!from || event.createdAt.slice(0, 10) >= from) &&
          (!to || event.createdAt.slice(0, 10) <= to) &&
          (!actorId || event.actorId === actorId),
      );
      const useHistoryFallback = events.rows.length === 0 && historyEvents.length > 0;
      const fallbackCounts = new Map<string, number>();
      if (useHistoryFallback) {
        for (const event of historyEvents) {
          fallbackCounts.set(event.actorId, (fallbackCounts.get(event.actorId) ?? 0) + 1);
        }
      }
      response.json({
        operators: operators.rows,
        summary: useHistoryFallback
          ? summary.rows.map((operator) => ({
              ...operator,
              taskCount: fallbackCounts.get(operator.actorId) ?? 0,
            }))
          : summary.rows,
        events: useHistoryFallback ? historyEvents.slice(0, 500) : events.rows,
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
      response.status(201).json(result.rows[0]);
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

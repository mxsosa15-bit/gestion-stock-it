import { randomUUID } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import type { Pool } from 'pg';
import { hashPassword, verifyPassword } from './password';

export interface InventorySnapshot {
  pisos: unknown[];
  areas: unknown[];
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

interface SessionUser {
  id: string;
  username: string;
  role: 'admin' | 'operator';
}

declare module 'express-session' {
  interface SessionData {
    user?: SessionUser;
  }
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
  stock: [],
  puestos: [],
  equiposRed: [],
  componentesRetirados: [],
  historial: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInventorySnapshot(value: unknown): value is InventorySnapshot {
  if (!isRecord(value)) return false;
  const snapshot = value as Record<string, unknown>;
  const recordCollections = Object.keys(emptySnapshot);
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

  const puestos = snapshot['puestos'] as Record<string, unknown>[];
  const stock = snapshot['stock'] as Record<string, unknown>[];
  const equiposRed = snapshot['equiposRed'] as Record<string, unknown>[];
  const componentesRetirados = snapshot['componentesRetirados'] as Record<string, unknown>[];
  return (
    puestos.every(
      (puesto) =>
        Array.isArray(puesto['componentes']) &&
        (puesto['componentes'] as unknown[]).every(
          (component) => isRecord(component) && typeof component['id'] === 'string',
        ),
    ) &&
    [...stock, ...puestos.flatMap((puesto) => puesto['componentes'] as Record<string, unknown>[])].every(
      (item) => typeof item['tipo'] === 'string' && peripheralTypes.has(item['tipo']),
    ) &&
    equiposRed.every(
      (equipo) => typeof equipo['tipo'] === 'string' && networkTypes.has(equipo['tipo']),
    ) &&
    componentesRetirados.every((item) => isRecord(item['componente']))
  );
}

function ensureTrackingCode(value: unknown, prefix: string): string {
  const code = typeof value === 'string' ? value.trim() : '';
  return code || `${prefix}-${randomUUID().replaceAll('-', '').toUpperCase()}`;
}

export function normalizeSnapshot(snapshot: InventorySnapshot): InventorySnapshot {
  return {
    ...snapshot,
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
      if (!externalTypes.has(String(insumo['tipo']))) {
        const { codigoSeguimiento: _codigoSeguimiento, ...interno } = insumo;
        return interno;
      }
      return {
        ...insumo,
        codigoSeguimiento: ensureTrackingCode(insumo['codigoSeguimiento'], 'INS'),
      };
    }),
    equiposRed: snapshot.equiposRed.map((equipo) => ({
      ...equipo,
      codigoSeguimiento: ensureTrackingCode(equipo['codigoSeguimiento'], 'RED'),
    })),
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

function requireUser(request: Request, response: Response, next: express.NextFunction): void {
  if (!request.session.user) {
    response.status(401).json({ error: 'Iniciá sesión para continuar.' });
    return;
  }
  next();
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
      response.status(400).json({ error: 'Ingresá un usuario válido y una contraseña de al menos 12 caracteres.' });
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

      const user: SessionUser = { id: randomUUID(), username, role: 'admin' };
      const passwordHash = await hashPassword(password);
      await client.query(
        'INSERT INTO gestion_it.app_users (id, username, password_hash, role) VALUES ($1, $2, $3, $4)',
        [user.id, username, passwordHash, user.role],
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
  router.post('/auth/login', (request, response, next) => {
    const now = Date.now();
    const key = request.ip ?? request.socket.remoteAddress ?? 'unknown';
    const current = loginFailures.get(key);
    if (current && current.resetAt > now && current.attempts >= 10) {
      response.status(429).json({ error: 'Demasiados intentos. Esperá 15 minutos antes de volver a intentar.' });
      return;
    }
    if (!current || current.resetAt <= now) {
      loginFailures.set(key, { attempts: 0, resetAt: now + 15 * 60 * 1000 });
    }
    next();
  }, async (request, response, next) => {
    const username = typeof request.body?.username === 'string' ? request.body.username.trim() : '';
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    try {
      const result = await pool.query<{
        id: string;
        username: string;
        password_hash: string;
        role: 'admin' | 'operator';
      }>(
        'SELECT id, username, password_hash, role FROM gestion_it.app_users WHERE username = $1',
        [username],
      );
      const record = result.rows[0];
      if (!record || !(await verifyPassword(password, record.password_hash))) {
        const key = request.ip ?? request.socket.remoteAddress ?? 'unknown';
        registerLoginFailure(key);
        response.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
        return;
      }
      loginFailures.delete(request.ip ?? request.socket.remoteAddress ?? 'unknown');
      const user: SessionUser = {
        id: record.id,
        username: record.username,
        role: record.role,
      };
      establishSession(request, response, user, next);
    } catch (error) {
      next(error);
    }
  });

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

  router.get('/inventory', requireUser, async (_request, response, next) => {
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

  router.put('/inventory', requireUser, async (request, response, next) => {
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
          error: 'Otro usuario modificó el inventario. Se recargaron los datos más recientes; volvé a intentar la operación.',
          revision: currentRow.revision,
          payload: currentRow.payload,
        });
        return;
      }

      const normalized = normalizeSnapshot(payload);
      if (!hasUniqueTrackingCodes(normalized)) {
        response.status(400).json({ error: 'El inventario contiene códigos de seguimiento duplicados.' });
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
      await client.query('COMMIT');
      response.json(saved.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      next(error);
    } finally {
      client.release();
    }
  });

  router.post('/inventory/import', requireUser, async (request, response, next) => {
    if (!isAdmin(request)) {
      response.status(403).json({ error: 'Solo una persona administradora puede importar un respaldo.' });
      return;
    }
    const { payload } = request.body ?? {};
    if (!isInventorySnapshot(payload)) {
      response.status(400).json({ error: 'El archivo no contiene un respaldo de inventario válido.' });
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
        response.status(409).json({ error: 'La importación solo se permite cuando el inventario del servidor está vacío.' });
        return;
      }
      const normalized = normalizeSnapshot(payload);
      if (!hasUniqueTrackingCodes(normalized)) {
        await client.query('ROLLBACK');
        response.status(400).json({ error: 'El respaldo contiene códigos de seguimiento duplicados.' });
        return;
      }
      const saved = await client.query<StoredSnapshot>(
        `UPDATE gestion_it.inventory_snapshot
         SET payload = $1::jsonb, revision = revision + 1, updated_at = now()
         WHERE singleton_id = true
         RETURNING revision::text, payload`,
        [JSON.stringify(normalized)],
      );
      await client.query('COMMIT');
      response.json(saved.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      next(error);
    } finally {
      client.release();
    }
  });

  router.get('/admin/users', requireUser, async (request, response, next) => {
    if (!isAdmin(request)) {
      response.status(403).json({ error: 'Permisos insuficientes.' });
      return;
    }
    try {
      const result = await pool.query(
        'SELECT id, username, role, created_at AS "createdAt" FROM gestion_it.app_users ORDER BY username',
      );
      response.json(result.rows);
    } catch (error) {
      next(error);
    }
  });

  router.post('/admin/users', requireUser, async (request, response, next) => {
    if (!isAdmin(request)) {
      response.status(403).json({ error: 'Permisos insuficientes.' });
      return;
    }
    const username = typeof request.body?.username === 'string' ? request.body.username.trim() : '';
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    const role = request.body?.role;
    if (
      !/^[a-zA-Z0-9._-]{3,64}$/.test(username) ||
      password.length < 12 ||
      (role !== 'admin' && role !== 'operator')
    ) {
      response.status(400).json({
        error: 'Ingresá un usuario válido, una contraseña de al menos 12 caracteres y un rol permitido.',
      });
      return;
    }
    try {
      const passwordHash = await hashPassword(password);
      const result = await pool.query(
        `INSERT INTO gestion_it.app_users (id, username, password_hash, role)
         VALUES ($1, $2, $3, $4)
         RETURNING id, username, role, created_at AS "createdAt"`,
        [randomUUID(), username, passwordHash, role],
      );
      response.status(201).json(result.rows[0]);
    } catch (error) {
      if (typeof error === 'object' && error && 'code' in error && error.code === '23505') {
        response.status(409).json({ error: 'Ya existe una cuenta con ese usuario.' });
        return;
      }
      next(error);
    }
  });

  router.use((error: unknown, _request: Request, response: Response, _next: express.NextFunction) => {
    console.error('Error en la API de Gestión IT:', error);
    response.status(500).json({ error: 'Ocurrió un error interno al procesar la solicitud.' });
  });

  return router;
}

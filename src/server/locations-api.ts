import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Pool } from 'pg';
import { recordOperatorAuditEvents } from './operator-audit';
import { requireRoles } from './session-user';

const requireLocationViewer = requireRoles(['admin', 'operator']);
const requireDashboardLocationViewer = requireRoles(['admin', 'operator', 'dashboard']);
const requireAdministrator = requireRoles(['admin']);

export interface LocationInput {
  nombre: string;
  departamento: string;
  localidad: string;
  direccion: string;
}

export function parseLocationInput(value: unknown): LocationInput | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const nombre = typeof body['nombre'] === 'string' ? body['nombre'].trim() : '';
  const departamento = typeof body['departamento'] === 'string' ? body['departamento'].trim() : '';
  const localidad = typeof body['localidad'] === 'string' ? body['localidad'].trim() : '';
  const direccion = typeof body['direccion'] === 'string' ? body['direccion'].trim() : '';
  if (
    !nombre ||
    nombre.length > 120 ||
    departamento.length > 120 ||
    localidad.length > 120 ||
    direccion.length > 300
  ) {
    return null;
  }
  return { nombre, departamento, localidad, direccion };
}

export function createLocationsApi(pool: Pool): express.Router {
  const router = express.Router();

  router.get(
    '/sedes/dashboard',
    requireDashboardLocationViewer,
    async (_request, response, next) => {
      try {
        const result = await pool.query(
          `SELECT id, nombre, tipo
         FROM gestion_it.sedes
         WHERE activa = true
         ORDER BY (tipo = 'CENTRAL') DESC, nombre`,
        );
        response.json(result.rows);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get('/sedes', requireLocationViewer, async (_request, response, next) => {
    try {
      const result = await pool.query(
        `SELECT id, nombre, tipo, departamento, localidad, direccion, activa
         FROM gestion_it.sedes
         WHERE activa = true
         ORDER BY (tipo = 'CENTRAL') DESC, nombre`,
      );
      response.json(result.rows);
    } catch (error) {
      next(error);
    }
  });

  router.post('/sedes', requireAdministrator, async (request, response, next) => {
    const location = parseLocationInput(request.body);
    if (!location) {
      response.status(400).json({ error: 'Completá un nombre válido para la sede.' });
      return;
    }
    try {
      const result = await pool.query(
        `INSERT INTO gestion_it.sedes (id, nombre, tipo, departamento, localidad, direccion)
         VALUES ($1, $2, 'DELEGACION', $3, $4, $5)
         RETURNING id, nombre, tipo, departamento, localidad, direccion, activa`,
        [
          randomUUID(),
          location.nombre,
          location.departamento,
          location.localidad,
          location.direccion,
        ],
      );
        const created = result.rows[0];
        if (created) {
          response.locals['operatorAuditContext'] = {
            entityId: created.id,
            entityName: created.nombre,
            details: {
              tipo: created.tipo,
              departamento: created.departamento,
              localidad: created.localidad,
            },
          };
        }
        response.status(201).json(created);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23505'
      ) {
        response.status(409).json({ error: 'Ya existe una sede con ese nombre.' });
        return;
      }
      next(error);
    }
  });

  router.patch('/sedes/:id', requireAdministrator, async (request, response, next) => {
    const location = parseLocationInput(request.body);
    if (!location) {
      response.status(400).json({ error: 'Completá los datos descriptivos de la sede.' });
      return;
    }

    const client = await pool.connect();
    let transactionStarted = false;
    try {
      await client.query('BEGIN');
      transactionStarted = true;
      const current = await client.query<{
        id: string;
        nombre: string;
        tipo: string;
        departamento: string;
        localidad: string;
        direccion: string;
        activa: boolean;
      }>(
        `SELECT id, nombre, tipo, departamento, localidad, direccion, activa
         FROM gestion_it.sedes
         WHERE id = $1 AND activa = true
         FOR UPDATE`,
        [request.params['id']],
      );
      const previous = current.rows[0];
      if (!previous) {
        await client.query('ROLLBACK');
        transactionStarted = false;
        response.status(404).json({ error: 'No se encontró la sede activa.' });
        return;
      }

      const result = await client.query(
        `UPDATE gestion_it.sedes
         SET nombre = $2, departamento = $3, localidad = $4, direccion = $5
         WHERE id = $1
         RETURNING id, nombre, tipo, departamento, localidad, direccion, activa`,
        [
          previous.id,
          location.nombre,
          location.departamento,
          location.localidad,
          location.direccion,
        ],
      );
      const updated = result.rows[0];
      const actor = request.session.user;
      if (!actor || !updated) throw new Error('No se pudo completar la edición de la sede.');
      await recordOperatorAuditEvents(client, actor, [
        {
          action: 'Actualizó los datos descriptivos de una sede',
          entityType: 'sede',
          entityId: updated.id,
          entityName: updated.nombre,
          details: {
            resultado: 'exitoso',
            anterior: {
              nombre: previous.nombre,
              departamento: previous.departamento,
              localidad: previous.localidad,
              direccion: previous.direccion,
            },
            posterior: {
              nombre: updated.nombre,
              departamento: updated.departamento,
              localidad: updated.localidad,
              direccion: updated.direccion,
            },
          },
        },
      ]);
      await client.query('COMMIT');
      transactionStarted = false;
      response.locals['operatorAuditRecordedTransactionally'] = true;
      response.json(updated);
    } catch (error) {
      if (transactionStarted) await client.query('ROLLBACK');
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23505'
      ) {
        response.status(409).json({ error: 'Ya existe una sede con ese nombre.' });
        return;
      }
      next(error);
    } finally {
      client.release();
    }
  });

  return router;
}

import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Pool } from 'pg';
import { requireRoles } from './session-user';

const requireLocationViewer = requireRoles(['admin', 'operator']);
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
      response.status(201).json(result.rows[0]);
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

  return router;
}

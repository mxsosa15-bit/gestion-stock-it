import { randomUUID } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { recordOperatorAuditEvents } from './operator-audit';
import { requireRoles } from './session-user';
import { DEFAULT_SEDE_ID } from '../shared/locations';

export const hardwareTypes = [
  'MONITOR',
  'IMPRESORA',
  'SCANNER',
  'TECLADO',
  'MOUSE',
  'OTRO',
] as const;
export type HardwareType = (typeof hardwareTypes)[number];

export interface HardwareAssetInput {
  tipo: HardwareType;
  marca: string;
  modelo: string | null;
  especificacion: string | null;
  numeroSerie: string;
  numeroPatrimonio: string | null;
  sedeId?: string;
}

export interface HardwareAsset extends HardwareAssetInput {
  id: string;
  fechaRegistro: Date;
}

export interface HardwareAssetEdit {
  tipo: HardwareType;
  marca: string;
  modelo: string | null;
  especificacion: string | null;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isHardwareType(value: unknown): value is HardwareType {
  return typeof value === 'string' && hardwareTypes.some((type) => type === value);
}

export function parseHardwareAsset(value: unknown): HardwareAssetInput | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const tipo = body['tipo'];
  const marca = typeof body['marca'] === 'string' ? body['marca'].trim() : '';
  const modelo = typeof body['modelo'] === 'string' ? body['modelo'].trim() || null : null;
  const especificacion =
    typeof body['especificacion'] === 'string' ? body['especificacion'].trim() || null : null;
  const numeroSerie = typeof body['numeroSerie'] === 'string' ? body['numeroSerie'].trim() : '';
  const rawNumeroPatrimonio = body['numeroPatrimonio'];
  const sedeId =
    typeof body['sedeId'] === 'string' && body['sedeId'].trim()
      ? body['sedeId'].trim()
      : DEFAULT_SEDE_ID;

  if (
    !isHardwareType(tipo) ||
    !marca ||
    marca.length > 120 ||
    !numeroSerie ||
    numeroSerie.length > 200 ||
    !uuidPattern.test(sedeId) ||
    (modelo !== null && modelo.length > 120) ||
    (especificacion !== null && especificacion.length > 500) ||
    (rawNumeroPatrimonio !== null &&
      rawNumeroPatrimonio !== undefined &&
      typeof rawNumeroPatrimonio !== 'string')
  ) {
    return null;
  }

  const numeroPatrimonio =
    typeof rawNumeroPatrimonio === 'string' ? rawNumeroPatrimonio.trim() || null : null;
  if (numeroPatrimonio && numeroPatrimonio.length > 100) return null;

  return { tipo, marca, modelo, especificacion, numeroSerie, numeroPatrimonio, sedeId };
}

export function parseHardwareAssetEdit(value: unknown): HardwareAssetEdit | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (
    !Object.keys(body).every((key) =>
      ['tipo', 'marca', 'modelo', 'especificacion'].includes(key),
    )
  ) {
    return null;
  }
  const tipo = body['tipo'];
  const marca = typeof body['marca'] === 'string' ? body['marca'].trim() : '';
  const rawModelo = body['modelo'];
  const rawEspecificacion = body['especificacion'];
  if (
    (typeof rawModelo !== 'string' && rawModelo !== null) ||
    (typeof rawEspecificacion !== 'string' && rawEspecificacion !== null)
  ) {
    return null;
  }
  const modelo = typeof rawModelo === 'string' ? rawModelo.trim() || null : null;
  const especificacion =
    typeof rawEspecificacion === 'string' ? rawEspecificacion.trim() || null : null;
  if (
    !isHardwareType(tipo) ||
    !marca ||
    marca.length > 120 ||
    (modelo !== null && modelo.length > 120) ||
    (especificacion !== null && especificacion.length > 500)
  ) {
    return null;
  }
  return { tipo, marca, modelo, especificacion };
}

function mapAssetColumns(asset: HardwareAssetInput): unknown[] {
  return [
    randomUUID(),
    asset.tipo,
    asset.marca,
    asset.modelo,
    asset.especificacion,
    asset.numeroSerie,
    asset.numeroPatrimonio,
    asset.sedeId ?? DEFAULT_SEDE_ID,
  ];
}

const requireHardwareManager = requireRoles(['admin', 'operator']);
const assetSelect = `id, tipo, marca, modelo, especificacion,
                     numero_serie AS "numeroSerie", numero_patrimonio AS "numeroPatrimonio",
                     sede_id::text AS "sedeId",
                     fecha_registro AS "fechaRegistro"`;

export function createHardwareAssetsApi(pool: Pool): express.Router {
  const router = express.Router();

  router.get('/hardware-assets', requireHardwareManager, async (_request, response, next) => {
    try {
      const result = await pool.query<HardwareAsset>(
        `SELECT ${assetSelect}
         FROM gestion_it.hardware_assets
         ORDER BY fecha_registro DESC, id`,
      );
      response.json(result.rows);
    } catch (error) {
      next(error);
    }
  });

  router.post('/hardware-assets', requireHardwareManager, async (request, response, next) => {
    const asset = parseHardwareAsset(request.body);
    if (!asset) {
      response.status(400).json({ error: 'Completá tipo, marca y número de serie válidos.' });
      return;
    }

    try {
      const result = await pool.query<HardwareAsset>(
        `INSERT INTO gestion_it.hardware_assets
           (id, tipo, marca, modelo, especificacion, numero_serie, numero_patrimonio, sede_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING ${assetSelect}`,
        mapAssetColumns(asset),
      );
      const created = result.rows[0];
      if (created) {
        response.locals['operatorAuditContext'] = {
          entityId: created.id,
          entityName: `${created.tipo} ${created.marca} ${created.modelo ?? ''}`.trim(),
          details: { tipo: created.tipo, sedeId: created.sedeId ?? null },
        };
      }
      response.status(201).json(created);
    } catch (error) {
      if (typeof error === 'object' && error && 'code' in error && error.code === '23505') {
        response.status(409).json({
          error: 'El número de serie o el número patrimonial ya está registrado.',
        });
        return;
      }
      next(error);
    }
  });

  router.post(
    '/hardware-assets/import',
    requireHardwareManager,
    async (request, response, next) => {
      const rawAssets: unknown = request.body?.assets;
      if (!Array.isArray(rawAssets) || rawAssets.length === 0 || rawAssets.length > 2000) {
        response.status(400).json({ error: 'El archivo debe contener entre 1 y 2000 equipos.' });
        return;
      }
      const assets = rawAssets.map(parseHardwareAsset);
      if (assets.some((asset) => asset === null)) {
        response.status(400).json({
          error: 'Hay filas inválidas. Cada fila debe incluir tipo, marca y número de serie.',
        });
        return;
      }
      const validAssets = assets.filter((asset): asset is HardwareAssetInput => asset !== null);
      const serialNumbers = validAssets.map((asset) => asset.numeroSerie.toLocaleLowerCase());
      const patrimonyNumbers = validAssets.flatMap((asset) =>
        asset.numeroPatrimonio ? [asset.numeroPatrimonio.toLocaleLowerCase()] : [],
      );
      if (
        new Set(serialNumbers).size !== serialNumbers.length ||
        new Set(patrimonyNumbers).size !== patrimonyNumbers.length
      ) {
        response
          .status(409)
          .json({ error: 'El archivo contiene series o números patrimoniales duplicados.' });
        return;
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const inserted: HardwareAsset[] = [];
        for (const asset of validAssets) {
          const result = await client.query<HardwareAsset>(
            `INSERT INTO gestion_it.hardware_assets
             (id, tipo, marca, modelo, especificacion, numero_serie, numero_patrimonio, sede_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING ${assetSelect}`,
            mapAssetColumns(asset),
          );
          inserted.push(result.rows[0]!);
        }
        const actor = request.session.user;
        if (!actor) throw new Error('La sesión ya no es válida.');
        await recordOperatorAuditEvents(client, actor, [
          {
            action: 'Importó equipos patrimoniales',
            entityType: 'equipo patrimonial',
            entityId: null,
            entityName: `Importó ${inserted.length} equipos patrimoniales`,
            details: {
              resultado: 'exitoso',
              cantidad: inserted.length,
              registros: inserted.map((asset) => ({
                id: asset.id,
                tipo: asset.tipo,
                marca: asset.marca,
                modelo: asset.modelo,
                sedeId: asset.sedeId ?? null,
              })),
            },
          },
        ]);
        await client.query('COMMIT');
        response.locals['operatorAuditRecordedTransactionally'] = true;
        response.status(201).json(inserted);
      } catch (error) {
        await client.query('ROLLBACK');
        if (typeof error === 'object' && error && 'code' in error && error.code === '23505') {
          response.status(409).json({
            error:
              'Una serie o un número patrimonial ya existe en el inventario; no se importó ninguna fila.',
          });
          return;
        }
        next(error);
      } finally {
        client.release();
      }
    },
  );

  router.patch('/hardware-assets/:id/details', requireHardwareManager, async (request, response, next) => {
    const changes = parseHardwareAssetEdit(request.body);
    if (!changes) {
      response.status(400).json({ error: 'Completá tipo, marca, modelo y especificación válidos.' });
      return;
    }

    const client = await pool.connect();
    let transactionStarted = false;
    try {
      await client.query('BEGIN');
      transactionStarted = true;
      const current = await client.query<HardwareAsset>(
        `SELECT ${assetSelect}
         FROM gestion_it.hardware_assets
         WHERE id = $1
         FOR UPDATE`,
        [request.params['id']],
      );
      const previous = current.rows[0];
      if (!previous) {
        await client.query('ROLLBACK');
        transactionStarted = false;
        response.status(404).json({ error: 'No se encontró el equipo.' });
        return;
      }

      const result = await client.query<HardwareAsset>(
        `UPDATE gestion_it.hardware_assets
         SET tipo = $2, marca = $3, modelo = $4, especificacion = $5
         WHERE id = $1
         RETURNING ${assetSelect}`,
        [previous.id, changes.tipo, changes.marca, changes.modelo, changes.especificacion],
      );
      const updated = result.rows[0];
      const actor = request.session.user;
      if (!updated || !actor) throw new Error('No se pudo completar la edición del equipo.');
      await recordOperatorAuditEvents(client, actor, [
        {
          action: 'Actualizó los datos descriptivos de un equipo patrimonial',
          entityType: 'equipo patrimonial',
          entityId: updated.id,
          entityName: `${updated.tipo} ${updated.marca} ${updated.modelo ?? ''}`.trim(),
          details: {
            resultado: 'exitoso',
            anterior: {
              tipo: previous.tipo,
              marca: previous.marca,
              modelo: previous.modelo,
              especificacion: previous.especificacion,
            },
            posterior: {
              tipo: updated.tipo,
              marca: updated.marca,
              modelo: updated.modelo,
              especificacion: updated.especificacion,
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
      next(error);
    } finally {
      client.release();
    }
  });

  router.put(
    '/hardware-assets/:id/patrimony',
    requireHardwareManager,
    async (request, response, next) => {
      const value: unknown = request.body?.numeroPatrimonio;
      if (value !== null && typeof value !== 'string') {
        response
          .status(400)
          .json({ error: 'Ingresá un número patrimonial válido o dejalo vacío.' });
        return;
      }
      const numeroPatrimonio = typeof value === 'string' ? value.trim() || null : null;
      if (numeroPatrimonio && numeroPatrimonio.length > 100) {
        response
          .status(400)
          .json({ error: 'El número patrimonial no puede superar 100 caracteres.' });
        return;
      }

      const client = await pool.connect();
      let transactionStarted = false;
      try {
        await client.query('BEGIN');
        transactionStarted = true;
        const current = await client.query<HardwareAsset>(
          `SELECT ${assetSelect}
           FROM gestion_it.hardware_assets
           WHERE id = $1
           FOR UPDATE`,
          [request.params['id']],
        );
        const previous = current.rows[0];
        if (!previous) {
          await client.query('ROLLBACK');
          transactionStarted = false;
          response.status(404).json({ error: 'No se encontró el equipo.' });
          return;
        }
        const result = await client.query<HardwareAsset>(
          `UPDATE gestion_it.hardware_assets
         SET numero_patrimonio = $2
         WHERE id = $1
         RETURNING ${assetSelect}`,
          [previous.id, numeroPatrimonio],
        );
        const updated = result.rows[0];
        const actor = request.session.user;
        if (!updated || !actor) throw new Error('No se pudo asociar la etiqueta patrimonial.');
        await recordOperatorAuditEvents(client, actor, [
          {
            action: 'Actualizó un número patrimonial',
            entityType: 'equipo patrimonial',
            entityId: updated.id,
            entityName: `${updated.tipo} ${updated.marca} ${updated.modelo ?? ''}`.trim(),
            details: {
              resultado: 'exitoso',
              anterior: { numeroPatrimonio: previous.numeroPatrimonio },
              posterior: { numeroPatrimonio: updated.numeroPatrimonio },
            },
          },
        ]);
        await client.query('COMMIT');
        transactionStarted = false;
        response.locals['operatorAuditRecordedTransactionally'] = true;
        response.json(updated);
      } catch (error) {
        if (transactionStarted) await client.query('ROLLBACK');
        if (typeof error === 'object' && error && 'code' in error && error.code === '23505') {
          response
            .status(409)
            .json({ error: 'Ese número patrimonial ya está asignado a otro equipo.' });
          return;
        }
        next(error);
      } finally {
        client.release();
      }
    },
  );

  router.use(
    (error: unknown, _request: Request, response: Response, next: express.NextFunction) => {
      if (response.headersSent) {
        next(error);
        return;
      }
      console.error('Error en el registro patrimonial:', error);
      response.status(500).json({ error: 'Ocurrió un error interno al procesar el equipo.' });
    },
  );

  return router;
}

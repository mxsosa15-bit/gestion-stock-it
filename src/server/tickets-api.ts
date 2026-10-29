import express, { type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { requireRoles } from './session-user';
import { TICKET_CATEGORIES, type TicketCategory } from '../shared/tickets';

interface TicketInput {
  titulo: string;
  descripcion: string;
  categoria: TicketCategory;
  puestoAfectadoId: string;
}

interface AffectedWorkstationRecord {
  id: string;
  nombrePuesto: string;
  usuarioAsignado: string;
}

interface TicketUpdate {
  estado: 'En proceso' | 'Terminado';
  solucion: string | null;
}

interface WorkshopTransferInput {
  equipo: string;
  identificacion: string;
  detalle: string;
}

interface WorkshopApprovalInput {
  aprobar: boolean;
  motivo: string | null;
}

interface WorkshopReturnInput {
  solucion: string;
}

interface WorkshopTransferRecord {
  id: string;
  equipo: string;
  identificacion: string;
  detalle: string;
  estado: 'Pendiente' | 'En taller' | 'Devuelto' | 'Rechazado';
  solicitado_at: string;
  solicitado_por_nombre: string;
  aprobado_at: string | null;
  aprobado_por_nombre: string | null;
  motivo_rechazo: string | null;
  devuelto_at: string | null;
  devuelto_por_nombre: string | null;
}

interface TicketRecord extends Omit<TicketInput, 'puestoAfectadoId'> {
  id: string;
  estado: 'Abierto' | 'En proceso' | 'Terminado';
  solucion: string | null;
  fecha_creacion: Date;
  fecha_resolucion: Date | null;
  usuario_id: string;
  usuario_area_id: string | null;
  inventory_area_id: string | null;
  usuario_nombre: string;
  area_nombre: string | null;
  puesto_afectado_id: string | null;
  nombre_afectado: string | null;
  taller: WorkshopTransferRecord | null;
}

interface DashboardTicketRecord {
  id: string;
  titulo: string;
  categoria: TicketCategory;
  estado: 'Abierto' | 'En proceso' | 'Terminado';
  fecha_creacion: Date;
  fecha_resolucion: Date | null;
  area_nombre: string | null;
  nombre_afectado: string | null;
  taller: { estado: WorkshopTransferRecord['estado'] } | null;
}

export function parseTicketInput(value: unknown): TicketInput | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;

  const body = value as Record<string, unknown>;
  const titulo = typeof body['titulo'] === 'string' ? body['titulo'].trim() : '';
  const descripcion = typeof body['descripcion'] === 'string' ? body['descripcion'].trim() : '';
  const categoria = body['categoria'];
  const puestoAfectadoId =
    typeof body['puestoAfectadoId'] === 'string' ? body['puestoAfectadoId'].trim() : '';

  if (
    !titulo ||
    titulo.length > 200 ||
    !descripcion ||
    descripcion.length > 10_000 ||
    typeof categoria !== 'string' ||
    !isTicketCategory(categoria) ||
    !puestoAfectadoId ||
    puestoAfectadoId.length > 200
  ) {
    return null;
  }
  return { titulo, descripcion, categoria, puestoAfectadoId };
}

export function parseWorkshopTransferInput(value: unknown): WorkshopTransferInput | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const equipo = typeof body['equipo'] === 'string' ? body['equipo'].trim() : '';
  const identificacion =
    typeof body['identificacion'] === 'string' ? body['identificacion'].trim() : '';
  const detalle = typeof body['detalle'] === 'string' ? body['detalle'].trim() : '';

  if (
    !equipo ||
    equipo.length > 200 ||
    !identificacion ||
    identificacion.length > 200 ||
    !detalle ||
    detalle.length > 2_000
  ) {
    return null;
  }
  return { equipo, identificacion, detalle };
}

export function parseWorkshopApprovalInput(value: unknown): WorkshopApprovalInput | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const aprobar = body['aprobar'];
  const rawMotivo = body['motivo'];
  if (typeof aprobar !== 'boolean') return null;
  if (rawMotivo !== undefined && rawMotivo !== null && typeof rawMotivo !== 'string') return null;
  const motivo = typeof rawMotivo === 'string' ? rawMotivo.trim() : null;
  if (motivo && motivo.length > 2_000) return null;
  if (!aprobar && !motivo) return null;
  return { aprobar, motivo };
}

export function parseWorkshopReturnInput(value: unknown): WorkshopReturnInput | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const rawSolucion = (value as Record<string, unknown>)['solucion'];
  const solucion = typeof rawSolucion === 'string' ? rawSolucion.trim() : '';
  if (!solucion || solucion.length > 10_000) return null;
  return { solucion };
}

export function parseTicketUpdate(value: unknown): TicketUpdate | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const estado = body['estado'];
  const rawSolucion = body['solucion'];

  if (estado !== 'En proceso' && estado !== 'Terminado') return null;
  if (rawSolucion !== undefined && rawSolucion !== null && typeof rawSolucion !== 'string') {
    return null;
  }
  const solucion = typeof rawSolucion === 'string' ? rawSolucion.trim() : null;
  if (solucion && solucion.length > 10_000) return null;
  if (estado === 'Terminado' && !solucion) return null;
  return { estado, solucion };
}

const ticketOrder = `ORDER BY t.fecha_creacion DESC, t.id DESC`;
const ticketSelect = `SELECT t.id, t.titulo, t.descripcion, t.categoria, t.estado, t.solucion,
                             t.fecha_creacion, t.fecha_resolucion, t.usuario_id,
                             t.puesto_afectado_id, t.nombre_afectado,
                             u.area_id AS usuario_area_id,
                             a.inventory_area_id,
                             u.username AS usuario_nombre, a.nombre AS area_nombre,
                             workshop.transferencia AS taller
                      FROM gestion_it.tickets AS t
                      JOIN gestion_it.app_users AS u ON u.id = t.usuario_id
                      LEFT JOIN gestion_it.areas AS a ON a.id = u.area_id
                      LEFT JOIN LATERAL (
                        SELECT jsonb_build_object(
                          'id', wt.id, 'equipo', wt.equipo, 'identificacion', wt.identificacion,
                          'detalle', wt.detalle, 'estado', wt.estado,
                          'solicitado_at', wt.solicitado_at,
                          'solicitado_por_nombre', requester.username,
                          'aprobado_at', wt.aprobado_at,
                          'aprobado_por_nombre', approver.username,
                          'motivo_rechazo', wt.motivo_rechazo,
                          'devuelto_at', wt.devuelto_at,
                          'devuelto_por_nombre', returner.username
                        ) AS transferencia
                        FROM gestion_it.ticket_workshop_transfers AS wt
                        JOIN gestion_it.app_users AS requester ON requester.id = wt.solicitado_por
                        LEFT JOIN gestion_it.app_users AS approver ON approver.id = wt.aprobado_por
                        LEFT JOIN gestion_it.app_users AS returner ON returner.id = wt.devuelto_por
                        WHERE wt.ticket_id = t.id
                        ORDER BY wt.solicitado_at DESC, wt.id DESC
                        LIMIT 1
                      ) AS workshop ON true`;

const requireOperator = requireRoles(['admin', 'operator']);
const requireRequester = requireRoles(['solicitante']);
const ticketListeners = new Set<
  (event: { id: string; action: string; usuarioAreaId: string | null }) => void
>();

function isTicketCategory(value: string): value is TicketCategory {
  return TICKET_CATEGORIES.some((category) => category === value);
}

export function canRequesterSeeTicketInArea(
  requesterAreaId: string | null,
  ticketAreaId: string | null,
): boolean {
  return requesterAreaId !== null && requesterAreaId === ticketAreaId;
}

function publishTicketEvent(id: string, action: string, usuarioAreaId: string | null): void {
  for (const listener of ticketListeners) {
    listener({ id, action, usuarioAreaId });
  }
}

async function loadTicket(pool: Pool, id: string): Promise<TicketRecord | undefined> {
  const result = await pool.query<TicketRecord>(`${ticketSelect} WHERE t.id = $1`, [id]);
  return result.rows[0];
}

export function createTicketsApi(pool: Pool): express.Router {
  const router = express.Router();

  router.get(
    '/tickets/events',
    requireRoles(['admin', 'operator', 'solicitante', 'dashboard']),
    (request, response) => {
      const viewer = request.session.user;
      if (!viewer) {
        response.status(401).json({ error: 'Iniciá sesión para continuar.' });
        return;
      }
      response.status(200);
      response.set({
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream',
        'X-Accel-Buffering': 'no',
      });
      response.flushHeaders();
      const listener = (event: { id: string; action: string; usuarioAreaId: string | null }) => {
        if (
          viewer.role === 'solicitante' &&
          !canRequesterSeeTicketInArea(viewer.areaId, event.usuarioAreaId)
        ) {
          return;
        }
        response.write(
          `event: ticket\ndata: ${JSON.stringify({ id: event.id, action: event.action })}\n\n`,
        );
      };
      const keepAlive = setInterval(() => response.write(': keep-alive\n\n'), 25_000);
      ticketListeners.add(listener);
      response.on('close', () => {
        clearInterval(keepAlive);
        ticketListeners.delete(listener);
      });
    },
  );

  router.get('/tickets/dashboard', requireRoles(['admin', 'operator', 'dashboard']), async (_request, response, next) => {
    try {
      const result = await pool.query<DashboardTicketRecord>(
        `SELECT t.id, t.titulo, t.categoria, t.estado,
                t.fecha_creacion, t.fecha_resolucion,
                a.nombre AS area_nombre, t.nombre_afectado,
                workshop.transferencia AS taller
         FROM gestion_it.tickets AS t
         JOIN gestion_it.app_users AS u ON u.id = t.usuario_id
         LEFT JOIN gestion_it.areas AS a ON a.id = u.area_id
         LEFT JOIN LATERAL (
           SELECT jsonb_build_object(
             'estado', wt.estado,
             'equipo', wt.equipo,
             'identificacion', wt.identificacion
           ) AS transferencia
           FROM gestion_it.ticket_workshop_transfers AS wt
           WHERE wt.ticket_id = t.id
           ORDER BY wt.solicitado_at DESC, wt.id DESC
           LIMIT 1
         ) AS workshop ON true
         ${ticketOrder}`,
      );
      response.json(result.rows);
    } catch (error) {
      next(error);
    }
  });

  router.get('/tickets', requireOperator, async (_request, response, next) => {
    try {
      const result = await pool.query<TicketRecord>(`${ticketSelect} ${ticketOrder}`);
      response.json(result.rows);
    } catch (error) {
      next(error);
    }
  });

  router.get('/tickets/areas/:areaId', requireOperator, async (request, response, next) => {
    const areaId = request.params['areaId'];
    if (typeof areaId !== 'string' || !areaId.trim()) {
      response.status(400).json({ error: 'Seleccioná un área válida.' });
      return;
    }
    try {
      const result = await pool.query<{ id: string }>(
        `${ticketSelect}
         WHERE a.inventory_area_id = $1
         ${ticketOrder}`,
        [areaId],
      );
      response.json(result.rows);
    } catch (error) {
      next(error);
    }
  });

  router.get('/areas/:areaId/puestos', requireRequester, async (request, response, next) => {
    const areaId = request.params['areaId'];
    const requesterAreaId = request.session.user?.areaId;
    if (typeof areaId !== 'string' || !areaId.trim()) {
      response.status(400).json({ error: 'Seleccioná un área válida.' });
      return;
    }
    if (!requesterAreaId || areaId !== requesterAreaId) {
      response.status(403).json({ error: 'Solo podés consultar los puestos de tu propia área.' });
      return;
    }

    try {
      const result = await pool.query<AffectedWorkstationRecord>(
        `SELECT workstation->>'id' AS id,
                COALESCE(NULLIF(btrim(workstation->>'nombrePuesto'), ''),
                         NULLIF(btrim(workstation->>'usuarioAsignado'), '')) AS "nombrePuesto",
                COALESCE(NULLIF(btrim(workstation->>'usuarioAsignado'), ''),
                         NULLIF(btrim(workstation->>'nombrePuesto'), '')) AS "usuarioAsignado"
         FROM gestion_it.areas AS area
         JOIN gestion_it.inventory_snapshot AS snapshot ON snapshot.singleton_id = true
         CROSS JOIN LATERAL jsonb_array_elements(
           COALESCE(snapshot.payload->'puestos', '[]'::jsonb)
         ) AS workstation
         WHERE area.id = $1
           AND area.activo = true
           AND area.inventory_area_id IS NOT NULL
           AND workstation->>'areaId' = area.inventory_area_id
           AND NULLIF(btrim(workstation->>'id'), '') IS NOT NULL
           AND (
             NULLIF(btrim(workstation->>'nombrePuesto'), '') IS NOT NULL
             OR NULLIF(btrim(workstation->>'usuarioAsignado'), '') IS NOT NULL
           )
         ORDER BY "usuarioAsignado", "nombrePuesto"`,
        [areaId],
      );
      response.json(result.rows);
    } catch (error) {
      next(error);
    }
  });

  router.get('/tickets/workshop', requireOperator, async (_request, response, next) => {
    try {
      const result = await pool.query<TicketRecord>(
        `${ticketSelect}
         WHERE t.estado <> 'Terminado'
           AND workshop.transferencia ->> 'estado' = 'En taller'
         ${ticketOrder}`,
      );
      response.json(result.rows);
    } catch (error) {
      next(error);
    }
  });

  router.get('/tickets/mine', requireRequester, async (request, response, next) => {
    const areaId = request.session.user?.areaId;
    if (!areaId) {
      response.json([]);
      return;
    }
    try {
      const result = await pool.query<TicketRecord>(
        `${ticketSelect} WHERE u.area_id = $1 ${ticketOrder}`,
        [areaId],
      );
      response.json(result.rows);
    } catch (error) {
      next(error);
    }
  });

  router.post('/tickets', requireRequester, async (request, response, next) => {
    const ticket = parseTicketInput(request.body);
    if (!ticket) {
      response.status(400).json({
        error:
          'Ingresá asunto, categoría, detalle del problema y el puesto afectado.',
      });
      return;
    }

    const user = request.session.user;
    if (!user?.areaId) {
      response.status(400).json({
        error: 'Tu cuenta no tiene un área asignada. Contactá a la administración.',
      });
      return;
    }

    try {
      const result = await pool.query<{ id: string }>(
        `INSERT INTO gestion_it.tickets
           (titulo, descripcion, categoria, usuario_id, puesto_afectado_id, nombre_afectado)
         SELECT $1, $2, $3, requester.id, workstation->>'id',
                COALESCE(NULLIF(btrim(workstation->>'usuarioAsignado'), ''),
                         NULLIF(btrim(workstation->>'nombrePuesto'), ''))
         FROM gestion_it.app_users AS requester
         JOIN gestion_it.areas AS area ON area.id = requester.area_id
         JOIN gestion_it.inventory_snapshot AS snapshot ON snapshot.singleton_id = true
         CROSS JOIN LATERAL jsonb_array_elements(
           COALESCE(snapshot.payload->'puestos', '[]'::jsonb)
         ) AS workstation
         WHERE requester.id = $4
           AND area.activo = true
           AND workstation->>'id' = $5
           AND workstation->>'areaId' = area.inventory_area_id
           AND NULLIF(btrim(workstation->>'id'), '') IS NOT NULL
           AND (
             NULLIF(btrim(workstation->>'nombrePuesto'), '') IS NOT NULL
             OR NULLIF(btrim(workstation->>'usuarioAsignado'), '') IS NOT NULL
           )
         RETURNING id`,
        [ticket.titulo, ticket.descripcion, ticket.categoria, user.id, ticket.puestoAfectadoId],
      );
      const created = result.rows[0];
      if (!created) {
        response.status(400).json({
          error: 'El puesto seleccionado no pertenece a tu área o ya no está disponible.',
        });
        return;
      }
      const completeTicket = await loadTicket(pool, created.id);
      if (!completeTicket) {
        response.status(500).json({ error: 'No se pudo recuperar el reclamo creado.' });
        return;
      }
      response.status(201).json(completeTicket);
      publishTicketEvent(completeTicket.id, 'created', completeTicket.usuario_area_id);
    } catch (error) {
      next(error);
    }
  });

  router.post('/tickets/:id/workshop', requireOperator, async (request, response, next) => {
    const transfer = parseWorkshopTransferInput(request.body);
    if (!transfer) {
      response.status(400).json({
        error: 'Indicá el equipo, su número de serie o patrimonio y el motivo de derivación.',
      });
      return;
    }
    const ticketId = request.params['id'];
    if (typeof ticketId !== 'string') {
      response.status(400).json({ error: 'El identificador del reclamo no es válido.' });
      return;
    }
    const operator = request.session.user;
    if (!operator) {
      response.status(401).json({ error: 'Iniciá sesión para continuar.' });
      return;
    }

    try {
      const created = await pool.query<{ id: string }>(
        `INSERT INTO gestion_it.ticket_workshop_transfers
           (ticket_id, equipo, identificacion, detalle, solicitado_por)
         SELECT t.id, $2, $3, $4, $5
         FROM gestion_it.tickets AS t
         WHERE t.id = $1 AND t.estado <> 'Terminado'
         RETURNING id`,
        [ticketId, transfer.equipo, transfer.identificacion, transfer.detalle, operator.id],
      );
      if (!created.rows[0]) {
        response.status(404).json({ error: 'No se encontró un reclamo activo para derivar.' });
        return;
      }
      const ticket = await loadTicket(pool, ticketId);
      if (!ticket) {
        response.status(404).json({ error: 'No se encontró el reclamo.' });
        return;
      }
      response.status(201).json(ticket);
      publishTicketEvent(ticket.id, 'workshop', ticket.usuario_area_id);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23505'
      ) {
        response.status(409).json({
          error: 'Este reclamo ya tiene una derivación pendiente o un equipo actualmente en taller.',
        });
        return;
      }
      next(error);
    }
  });

  router.patch(
    '/tickets/:id/workshop/:transferId',
    requireRequester,
    async (request, response, next) => {
      const approval = parseWorkshopApprovalInput(request.body);
      if (!approval) {
        response.status(400).json({
          error: 'Confirmá la aprobación o indicá el motivo para rechazar la derivación.',
        });
        return;
      }
      const requester = request.session.user;
      if (!requester) {
        response.status(401).json({ error: 'Iniciá sesión para continuar.' });
        return;
      }
      const ticketId = request.params['id'];
      const transferId = request.params['transferId'];
      if (typeof ticketId !== 'string' || typeof transferId !== 'string') {
        response.status(400).json({ error: 'El identificador de la derivación no es válido.' });
        return;
      }

      try {
        const updated = await pool.query(
          `UPDATE gestion_it.ticket_workshop_transfers AS wt
           SET estado = $4,
               aprobado_por = $5,
               aprobado_at = now(),
               motivo_rechazo = $6
           WHERE wt.id = $1
             AND wt.ticket_id = $2
             AND wt.estado = 'Pendiente'
             AND EXISTS (
               SELECT 1 FROM gestion_it.tickets AS t
               WHERE t.id = wt.ticket_id
                 AND t.usuario_id = $3
                 AND t.estado <> 'Terminado'
             )
           RETURNING wt.id`,
          [
            transferId,
            ticketId,
            requester.id,
            approval.aprobar ? 'En taller' : 'Rechazado',
            requester.id,
            approval.aprobar ? null : approval.motivo,
          ],
        );
        if (!updated.rows[0]) {
          response.status(404).json({
            error: 'No se encontró una derivación pendiente para uno de tus reclamos.',
          });
          return;
        }
        const ticket = await loadTicket(pool, ticketId);
        if (!ticket) {
          response.status(404).json({ error: 'No se encontró el reclamo.' });
          return;
        }
        response.json(ticket);
        publishTicketEvent(ticket.id, 'workshop', ticket.usuario_area_id);
      } catch (error) {
        next(error);
      }
    },
  );

  router.patch(
    '/tickets/:id/workshop/:transferId/return',
    requireOperator,
    async (request, response, next) => {
      const workshopReturn = parseWorkshopReturnInput(request.body);
      if (!workshopReturn) {
        response.status(400).json({
          error: 'Ingresá la solución o el trabajo realizado antes de registrar la devolución.',
        });
        return;
      }

      const ticketId = request.params['id'];
      const transferId = request.params['transferId'];
      const operator = request.session.user;
      if (typeof ticketId !== 'string' || typeof transferId !== 'string') {
        response.status(400).json({ error: 'El identificador de la derivación no es válido.' });
        return;
      }
      if (!operator) {
        response.status(401).json({ error: 'Iniciá sesión para continuar.' });
        return;
      }

      const client = await pool.connect();
      let transactionStarted = false;
      try {
        await client.query('BEGIN');
        transactionStarted = true;
        const ticket = await client.query<{ estado: string }>(
          'SELECT estado FROM gestion_it.tickets WHERE id = $1 FOR UPDATE',
          [ticketId],
        );
        if (!ticket.rows[0]) {
          await client.query('ROLLBACK');
          transactionStarted = false;
          response.status(404).json({ error: 'No se encontró el reclamo.' });
          return;
        }
        if (ticket.rows[0].estado === 'Terminado') {
          await client.query('ROLLBACK');
          transactionStarted = false;
          response.status(409).json({ error: 'El reclamo ya está terminado.' });
          return;
        }

        const returned = await client.query(
          `UPDATE gestion_it.ticket_workshop_transfers
           SET estado = 'Devuelto', devuelto_por = $3, devuelto_at = now()
           WHERE id = $1 AND ticket_id = $2 AND estado = 'En taller'
           RETURNING id`,
          [transferId, ticketId, operator.id],
        );
        if (!returned.rows[0]) {
          await client.query('ROLLBACK');
          transactionStarted = false;
          response.status(409).json({
            error: 'El equipo no figura en taller o ya se registró su devolución.',
          });
          return;
        }

        const completed = await client.query(
          `UPDATE gestion_it.tickets
           SET estado = 'Terminado',
               solucion = $2,
               fecha_resolucion = now()
           WHERE id = $1 AND estado <> 'Terminado'
           RETURNING id`,
          [ticketId, workshopReturn.solucion],
        );
        if (!completed.rows[0]) {
          await client.query('ROLLBACK');
          transactionStarted = false;
          response.status(409).json({ error: 'No se pudo terminar el reclamo.' });
          return;
        }

        await client.query('COMMIT');
        transactionStarted = false;
        const completeTicket = await loadTicket(pool, ticketId);
        if (!completeTicket) {
          response.status(500).json({ error: 'No se pudo recuperar el reclamo actualizado.' });
          return;
        }
        response.json(completeTicket);
        publishTicketEvent(completeTicket.id, 'workshop', completeTicket.usuario_area_id);
      } catch (error) {
        if (transactionStarted) await client.query('ROLLBACK');
        next(error);
      } finally {
        client.release();
      }
    },
  );

  router.patch('/tickets/:id', requireOperator, async (request, response, next) => {
    const ticket = parseTicketUpdate(request.body);
    if (!ticket) {
      response.status(400).json({
        error: 'Elegí un estado válido e ingresá la solución para terminar el reclamo.',
      });
      return;
    }

    try {
      const result = await pool.query<{ id: string }>(
        `UPDATE gestion_it.tickets AS t
         SET estado = $2,
             solucion = CASE WHEN $2 = 'Terminado' THEN $3 ELSE t.solucion END,
             fecha_resolucion = CASE
               WHEN $2 = 'Terminado' THEN COALESCE(t.fecha_resolucion, now())
               ELSE NULL
             END
         WHERE t.id = $1
           AND (
             $2 <> 'Terminado'
             OR NOT EXISTS (
               SELECT 1 FROM gestion_it.ticket_workshop_transfers AS wt
               WHERE wt.ticket_id = t.id
                 AND wt.estado IN ('Pendiente', 'En taller')
             )
           )
         RETURNING t.id`,
        [request.params['id'], ticket.estado, ticket.solucion],
      );
      const updated = result.rows[0];
      if (!updated) {
        const blockingTransfer = await pool.query<{ estado: string }>(
          `SELECT estado
           FROM gestion_it.ticket_workshop_transfers
           WHERE ticket_id = $1 AND estado IN ('Pendiente', 'En taller')
           ORDER BY solicitado_at DESC
           LIMIT 1`,
          [request.params['id']],
        );
        const blockedByWorkshopState = blockingTransfer.rows[0]?.estado;
        if (blockedByWorkshopState) {
          response.status(409).json({
            error: blockedByWorkshopState === 'Pendiente'
              ? 'No podés terminar el reclamo hasta que el solicitante responda sobre el equipo.'
              : 'No podés terminar el reclamo hasta registrar la devolución del equipo desde Taller y scrap.',
          });
          return;
        }
        response.status(404).json({ error: 'No se encontró el reclamo.' });
        return;
      }

      const completeTicket = await loadTicket(pool, updated.id);
      if (!completeTicket) {
        response.status(404).json({ error: 'No se encontró el reclamo.' });
        return;
      }
      response.json(completeTicket);
      publishTicketEvent(completeTicket.id, 'updated', completeTicket.usuario_area_id);
    } catch (error) {
      next(error);
    }
  });

  router.use(
    (error: unknown, _request: Request, response: Response, next: express.NextFunction) => {
      if (response.headersSent) {
        next(error);
        return;
      }
      console.error('Error en la API de tickets:', error);
      response.status(500).json({ error: 'Ocurrió un error interno al procesar el reclamo.' });
    },
  );

  return router;
}

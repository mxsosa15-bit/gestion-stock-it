import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import type { Pool, PoolClient } from 'pg';
import {
  describeInventoryChange,
  excludeAuditedStockMovementHistory,
  inventoryHistoryAuditEvents,
} from './operator-audit';
import {
  installOperatorAuditMiddleware,
  recordOperatorAuditEvents,
} from './operator-audit';

const emptyInventory = {
  pisos: [],
  areas: [],
  personas: [],
  stock: [],
  puestos: [],
  equiposRed: [],
  componentesRetirados: [],
  historial: [],
};

describe('describeInventoryChange', () => {
  it('records additions as one task and identifies the created inventory items', () => {
    const events = describeInventoryChange(emptyInventory, {
      ...emptyInventory,
      areas: [{ id: 'area-1', nombre: 'Sistemas' }],
      puestos: [
        {
          id: 'puesto-1',
          nombrePuesto: 'Puesto 1',
          componentes: [{ id: 'component-1', tipo: 'MONITOR', marca: 'Dell' }],
        },
      ],
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('Actualizó el inventario');
    expect(events[0]?.entityName).toContain('Creó 1 área');
    expect(events[0]?.entityName).toContain('Creó 1 puesto');
    expect(events[0]?.entityName).toContain('Agregó 1 componente de puesto');
  });

  it('does not count the workstation as edited when only its components change', () => {
    const before = {
      ...emptyInventory,
      puestos: [{ id: 'puesto-1', nombrePuesto: 'Puesto 1', componentes: [] }],
    };
    const after = {
      ...emptyInventory,
      puestos: [
        {
          id: 'puesto-1',
          nombrePuesto: 'Puesto 1',
          componentes: [{ id: 'component-1', tipo: 'MONITOR', marca: 'Dell' }],
        },
      ],
    };
    const events = describeInventoryChange(before, after);

    expect(events).toHaveLength(1);
    expect(events[0]?.entityName).toBe('Agregó 1 componente de puesto (MONITOR Dell)');
  });

  it('does not create an audit event when the inventory did not change', () => {
    expect(describeInventoryChange(emptyInventory, emptyInventory)).toEqual([]);
  });

  it('includes safe before-and-after values for changed inventory records', () => {
    const stockItem = {
      id: 'stock-1',
      tipo: 'MONITOR',
      marca: 'Dell',
      especificacion: '24 pulgadas',
      cantidadDisponible: 4,
      stockMinimo: 2,
      password: 'must-not-be-recorded',
    };
    const before = {
      ...emptyInventory,
      stock: [stockItem],
    };
    const after = {
      ...before,
      stock: [{ ...stockItem, cantidadDisponible: 3 }],
    };

    const [event] = describeInventoryChange(before, after);

    expect(event?.details['registros']).toMatchObject([
      {
        registroId: 'stock-1',
        anterior: { cantidadDisponible: 4 },
        posterior: { cantidadDisponible: 3 },
      },
    ]);
    expect(JSON.stringify(event?.details)).not.toContain('must-not-be-recorded');
  });

  it('audits new inventory history entries once with a safe field allowlist', () => {
    const events = describeInventoryChange(emptyInventory, {
      ...emptyInventory,
      historial: [
        {
          id: 'movement-1',
          tipo: 'ALTA_PUESTO',
          fecha: '2026-11-12T10:00:00.000Z',
          cantidad: 1,
          detalle: 'Se creó un puesto',
          operadorId: '4ba4e2ce-5c45-44fb-b4c7-f50a8f3c6b41',
          password: 'must-not-be-recorded',
        },
      ],
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.entityName).toContain('Registró 1 movimiento de inventario');
    expect(events[0]?.details['registros']).toMatchObject([
      {
        registroId: 'movement-1',
        anterior: null,
        posterior: {
          tipo: 'ALTA_PUESTO',
          fecha: '2026-11-12T10:00:00.000Z',
          cantidad: 1,
          detalle: 'Se creó un puesto',
        },
      },
    ]);
    expect(events[0]?.details['historialMovimientoIds']).toEqual(['movement-1']);
    expect(JSON.stringify(events[0]?.details)).not.toContain('must-not-be-recorded');
  });
});

describe('inventoryHistoryAuditEvents', () => {
  it('converts only attributable inventory movements into audit events', () => {
    const events = inventoryHistoryAuditEvents([
      {
        id: 'movement-1',
        fecha: '2026-11-12T10:00:00.000Z',
        operadorId: '4ba4e2ce-5c45-44fb-b4c7-f50a8f3c6b41',
        operador: 'operador1',
        tipo: 'ALTA_PUESTO',
        detalle: 'Se creó un puesto',
      },
      {
        id: 'movement-2',
        fecha: '2026-11-12T11:00:00.000Z',
        tipo: 'BAJA_PUESTO',
        detalle: 'Se eliminó un puesto',
      },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: 'historial-movement-1',
      actorId: '4ba4e2ce-5c45-44fb-b4c7-f50a8f3c6b41',
      actorUsername: 'operador1',
      entityName: 'Se creó un puesto',
      details: { tipo: 'ALTA_PUESTO' },
    });
  });

  it('does not synthesize a second event for history already in a transactional inventory audit', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ entity_id: 'movement-1' }] });
    const events = inventoryHistoryAuditEvents([
      {
        id: 'movement-1',
        fecha: '2026-11-12T10:00:00.000Z',
        operadorId: '4ba4e2ce-5c45-44fb-b4c7-f50a8f3c6b41',
        operador: 'operador1',
        tipo: 'ALTA_PUESTO',
        detalle: 'Se creó un puesto',
      },
    ]);

    await expect(
      excludeAuditedStockMovementHistory({ query } as unknown as Pool, events),
    ).resolves.toEqual([]);
    expect(query.mock.calls[0]?.[0]).toContain("entry->>'registroId'");
  });

  describe('stock shipment operator audit', () => {
    const actor = {
      id: '11111111-1111-4111-8111-111111111111',
      username: 'operador',
      role: 'operator' as const,
      areaId: null,
      areaNombre: null,
    };

    function runAudit(alreadyProcessed: boolean, query: ReturnType<typeof vi.fn>) {
      const response = Object.assign(new EventEmitter(), {
        statusCode: 200,
        locals: {
          stockShipmentAudit: {
            idempotencyKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            movementId: 'hist-original',
            alreadyProcessed,
          },
        },
      });
      const request = {
        session: { user: actor },
        method: 'POST',
        path: '/inventory/stock-transfers',
      } as unknown as Request;
      const middleware = installOperatorAuditMiddleware({ query } as unknown as Pool);

      middleware(request, response as unknown as Response, vi.fn());
      response.emit('finish');
    }

    it('does not add a second canonical event for a newly processed shipment', () => {
      const query = vi.fn().mockResolvedValue({ rows: [] });

      runAudit(false, query);

      expect(query).not.toHaveBeenCalled();
    });

    it('records an idempotent retry as a distinct trace event', async () => {
      const query = vi.fn().mockResolvedValue({ rows: [] });

      runAudit(true, query);
      await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));

      const events = JSON.parse(query.mock.calls[0]?.[1][2] as string) as Record<string, unknown>[];
      expect(events[0]).toMatchObject({
        action: 'Reintentó un envío de stock ya procesado',
        entity_type: 'reintento de envío de stock',
        entity_id: 'hist-original',
        details: {
          idempotencyKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          movementId: 'hist-original',
          resultado: 'ya_procesado',
        },
      });
    });
  });

  describe('mutation outcomes', () => {
    const actor = {
      id: '11111111-1111-4111-8111-111111111111',
      username: 'operador',
      role: 'operator' as const,
      areaId: null,
      areaNombre: null,
    };

    it('records unsuccessful mutation responses as failed attempts', async () => {
      const query = vi.fn().mockResolvedValue({ rows: [] });
      const response = Object.assign(new EventEmitter(), {
        statusCode: 409,
        locals: {},
      });
      const request = {
        session: { user: actor },
        method: 'POST',
        path: '/tickets',
      } as unknown as Request;

      installOperatorAuditMiddleware({ query } as unknown as Pool)(
        request,
        response as unknown as Response,
        vi.fn(),
      );
      response.emit('finish');
      await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));

      const events = JSON.parse(query.mock.calls[0]?.[1][2] as string) as Record<
        string,
        unknown
      >[];
      expect(events[0]?.['details']).toMatchObject({ resultado: 'fallido', codigoHttp: 409 });
    });

    it('does not duplicate a mutation already recorded in its transaction', () => {
      const query = vi.fn().mockResolvedValue({ rows: [] });
      const response = Object.assign(new EventEmitter(), {
        statusCode: 201,
        locals: { operatorAuditRecordedTransactionally: true },
      });
      const request = {
        session: { user: actor },
        method: 'POST',
        path: '/operator-tasks',
      } as unknown as Request;

      installOperatorAuditMiddleware({ query } as unknown as Pool)(
        request,
        response as unknown as Response,
        vi.fn(),
      );
      response.emit('finish');

      expect(query).not.toHaveBeenCalled();
    });

    it('redacts credential-like values before writing audit details', async () => {
      const query = vi.fn().mockResolvedValue({ rows: [] });
      await recordOperatorAuditEvents({ query } as unknown as PoolClient, actor, [
        {
          action: 'Actualizó tarea',
          entityType: 'tarea',
          entityId: 'task-1',
          entityName: 'Configuración',
          details: {
            password: 'sensitive',
            descripcion: 'token=abc123 Bearer jwtvalue',
          },
        },
      ]);

      const events = JSON.parse(query.mock.calls[0]?.[1][2] as string) as Record<
        string,
        unknown
      >[];
      expect(events[0]?.['details']).toEqual({
        password: '[REDACTED]',
        descripcion: 'token=[REDACTED] Bearer [REDACTED]',
      });
    });
  });
});

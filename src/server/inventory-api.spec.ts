import {
  applyStockShipment,
  attributeHistoryOperators,
  areDelegationStockChangesValid,
  areExistingComponentsUnchanged,
  createLoginFailureKey,
  executeStockShipment,
  normalizeSnapshot,
  parseComponentEdit,
  parseManagedUserUpdate,
  parsePasswordReset,
  parseStockShipmentRequest,
  StockShipmentIdempotencyConflictError,
  StockShipmentValidationError,
  type InventorySnapshot,
} from './inventory-api';
import type { Pool } from 'pg';

interface FakeShipmentRecord {
  actorId: string;
  fingerprint: string;
  movementId: string;
  processedRevision: string | null;
}

interface FakeStoredSnapshot {
  revision: string;
  payload: InventorySnapshot;
}

class FakeStockShipmentPool {
  current: FakeStoredSnapshot = {
    revision: '1',
    payload: {
      pisos: [],
      areas: [],
      stock: [
        {
          id: 'stock-central',
          tipo: 'RAM',
          marca: 'Kingston',
          especificacion: '8 GB',
          cantidadDisponible: 10,
          stockMinimo: 2,
          sedeId: '00000000-0000-4000-8000-000000000001',
        },
      ],
      puestos: [],
      equiposRed: [],
      componentesRetirados: [],
      historial: [],
    },
  };
  readonly shipments = new Map<string, FakeShipmentRecord>();
  readonly auditEvents: Record<string, unknown>[] = [];
  failSnapshotUpdate = false;
  failAuditInsert = false;
  private lockTail: Promise<void> = Promise.resolve();

  asPool(): Pool {
    return {
      connect: async () => {
        let transactionRelease: (() => void) | null = null;
        let local: FakeStoredSnapshot | null = null;
        let pending: { key: string; record: FakeShipmentRecord } | null = null;
        return {
          query: async (sql: string, values: unknown[] = []) => {
            const statement = sql.replace(/\s+/g, ' ').trim();
            if (statement === 'BEGIN') {
              transactionRelease = await this.acquireTransaction();
              local = structuredClone(this.current);
              return { rows: [] };
            }
            if (statement === 'COMMIT') {
              if (local && local.revision !== this.current.revision) {
                this.current = local;
              }
              if (pending) this.shipments.set(pending.key, pending.record);
              transactionRelease?.();
              transactionRelease = null;
              return { rows: [] };
            }
            if (statement === 'ROLLBACK') {
              transactionRelease?.();
              transactionRelease = null;
              return { rows: [] };
            }
            if (statement.startsWith('INSERT INTO gestion_it.inventory_stock_shipments')) {
              const key = String(values[0]);
              if (this.shipments.has(key)) return { rows: [] };
              pending = {
                key,
                record: {
                  actorId: String(values[1]),
                  fingerprint: String(values[2]),
                  movementId: String(values[7]),
                  processedRevision: null,
                },
              };
              return { rows: [{ idempotency_key: key }] };
            }
            if (
              statement.startsWith(
                'SELECT actor_id::text, request_fingerprint, movement_id, processed_revision::text',
              )
            ) {
              const record = this.shipments.get(String(values[0]));
              return {
                rows: record
                  ? [
                      {
                        actor_id: record.actorId,
                        request_fingerprint: record.fingerprint,
                        movement_id: record.movementId,
                        processed_revision: record.processedRevision,
                      },
                    ]
                  : [],
              };
            }
            if (
              statement.startsWith(
                'SELECT revision::text, payload FROM gestion_it.inventory_snapshot',
              )
            ) {
              const snapshot = local ?? this.current;
              return {
                rows: [{ revision: snapshot.revision, payload: structuredClone(snapshot.payload) }],
              };
            }
            if (statement.startsWith('SELECT nombre FROM gestion_it.sedes')) {
              return { rows: [{ nombre: 'Delegación Norte' }] };
            }
            if (statement.startsWith('SELECT id::text FROM gestion_it.sedes')) {
              const ids = values[0] as string[];
              return { rows: ids.map((id) => ({ id })) };
            }
            if (statement.startsWith('UPDATE gestion_it.inventory_snapshot')) {
              if (this.failSnapshotUpdate) throw new Error('simulated snapshot update failure');
              if (!local) throw new Error('snapshot update outside transaction');
              local = {
                revision: String(Number(local.revision) + 1),
                payload: JSON.parse(String(values[0])) as InventorySnapshot,
              };
              return { rows: [{ revision: local.revision, payload: local.payload }] };
            }
            if (statement.startsWith('UPDATE gestion_it.inventory_stock_shipments')) {
              if (pending) pending.record.processedRevision = String(values[1]);
              return { rows: [] };
            }
            if (statement.startsWith('INSERT INTO gestion_it.operator_audit_events')) {
              if (this.failAuditInsert) throw new Error('simulated audit insert failure');
              const events = JSON.parse(String(values[2])) as Record<string, unknown>[];
              this.auditEvents.push(
                ...events.map((event) => ({
                  actor_id: values[0],
                  actor_username: values[1],
                  action: event['action'],
                  entity_type: event['entity_type'],
                  entity_id: event['entity_id'],
                  entity_name: event['entity_name'],
                  details: event['details'],
                })),
              );
              return { rows: [] };
            }
            throw new Error(`Unexpected SQL in fake pool: ${statement}`);
          },
          release: () => {
            transactionRelease?.();
            transactionRelease = null;
          },
        };
      },
    } as unknown as Pool;
  }

  private async acquireTransaction(): Promise<() => void> {
    const previous = this.lockTail;
    let release!: () => void;
    this.lockTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }
}

function snapshotWithComponent(component: Record<string, unknown>): InventorySnapshot {
  return {
    pisos: [],
    areas: [],
    stock: [],
    puestos: [{ id: 'puesto-1', componentes: [component] }],
    equiposRed: [],
    componentesRetirados: [],
    historial: [],
  };
}

describe('normalizeSnapshot', () => {
  it('generates unique tracking codes on the server only for trackable inventory', () => {
    const snapshot: InventorySnapshot = {
      pisos: [],
      areas: [],
      stock: [
        { id: 'stock-monitor', tipo: 'MONITOR', marca: 'Dell' },
        { id: 'stock-ram', tipo: 'RAM', marca: 'Kingston' },
      ],
      puestos: [
        {
          id: 'puesto-1',
          codigoSeguimiento: '',
          componentes: [
            { id: 'monitor-1', tipo: 'MONITOR' },
            { id: 'ram-1', tipo: 'RAM', codigoSeguimiento: 'NO-DEBE-APLICAR' },
          ],
        },
      ],
      equiposRed: [{ id: 'red-1', codigoSeguimiento: '' }],
      componentesRetirados: [],
      historial: [],
    };

    const result = normalizeSnapshot(snapshot);
    const puesto = result.puestos[0]!;
    const component = (puesto['componentes'] as Record<string, unknown>[])[0]!;
    const ram = (puesto['componentes'] as Record<string, unknown>[])[1]!;
    const codes = [
      String(puesto['codigoSeguimiento']),
      String(component['codigoSeguimiento']),
      String(result.stock[0]?.['codigoSeguimiento']),
      String(result.equiposRed[0]?.['codigoSeguimiento']),
    ];

    expect(codes.every((code) => code.length > 0)).toBe(true);
    expect(new Set(codes).size).toBe(codes.length);
    expect(ram).not.toHaveProperty('codigoSeguimiento');
    expect(result.stock[1]).not.toHaveProperty('codigoSeguimiento');
  });

  it('assigns legacy floors and stock to Casa Central while preserving explicit locations', () => {
    const result = normalizeSnapshot({
      pisos: [
        { id: 'legacy-floor', nombre: 'Planta baja', nivel: 0 },
        {
          id: 'remote-floor',
          nombre: 'Oficina',
          nivel: 0,
          sedeId: '11111111-1111-4111-8111-111111111111',
        },
      ],
      areas: [],
      stock: [{ id: 'legacy-stock', tipo: 'RAM' }],
      puestos: [],
      equiposRed: [],
      componentesRetirados: [],
      historial: [],
    });

    expect(result.pisos.map((floor) => floor['sedeId'])).toEqual([
      '00000000-0000-4000-8000-000000000001',
      '11111111-1111-4111-8111-111111111111',
    ]);
    expect(result.stock[0]?.['sedeId']).toBe('00000000-0000-4000-8000-000000000001');
  });
});

describe('attributeHistoryOperators', () => {
  const actor = {
    id: 'operator-1',
    username: 'operador1',
    role: 'operator' as const,
    areaId: null,
    areaNombre: null,
  };

  it('attributes newly added history entries to the authenticated operator', () => {
    const snapshot: InventorySnapshot = {
      pisos: [],
      areas: [],
      stock: [],
      puestos: [],
      equiposRed: [],
      componentesRetirados: [],
      historial: [{ id: 'movement-1', detalle: 'Se creó un puesto' }],
    };

    const result = attributeHistoryOperators({ ...snapshot, historial: [] }, snapshot, actor);

    expect(result.historial[0]).toMatchObject({
      id: 'movement-1',
      operadorId: actor.id,
      operador: actor.username,
    });
  });

  it('preserves the original operator and rejects client changes to existing attribution', () => {
    const current: InventorySnapshot = {
      pisos: [],
      areas: [],
      stock: [],
      puestos: [],
      equiposRed: [],
      componentesRetirados: [],
      historial: [
        {
          id: 'movement-1',
          detalle: 'Se creó un puesto',
          operadorId: 'original-operator',
          operador: 'operador-original',
        },
      ],
    };
    const proposed: InventorySnapshot = {
      ...current,
      historial: [
        {
          id: 'movement-1',
          detalle: 'Se creó un puesto',
          operadorId: 'forged-operator',
          operador: 'operador-falso',
        },
      ],
    };

    const result = attributeHistoryOperators(current, proposed, actor);

    expect(result.historial[0]).toMatchObject({
      id: 'movement-1',
      operadorId: 'original-operator',
      operador: 'operador-original',
    });
  });
});

describe('parseStockShipmentRequest', () => {
  const idempotencyKey = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  it('accepts a complete shipment request and trims its text fields', () => {
    expect(
      parseStockShipmentRequest({
        expectedActorId: '11111111-1111-4111-8111-111111111111',
        idempotencyKey,
        insumoId: ' stock-1 ',
        destinoSedeId: '11111111-1111-4111-8111-111111111111',
        cantidad: 3,
        motivo: ' Reposición ',
      }),
    ).toEqual({
      expectedActorId: '11111111-1111-4111-8111-111111111111',
      idempotencyKey,
      insumoId: 'stock-1',
      destinoSedeId: '11111111-1111-4111-8111-111111111111',
      cantidad: 3,
      motivo: 'Reposición',
    });
  });

  it('rejects invalid quantities, destinations, and missing reasons', () => {
    const request = {
      expectedActorId: '11111111-1111-4111-8111-111111111111',
      idempotencyKey,
      insumoId: 'stock-1',
      destinoSedeId: '11111111-1111-4111-8111-111111111111',
      cantidad: 3,
      motivo: 'Reposición',
    };
    expect(parseStockShipmentRequest({ ...request, cantidad: 0 })).toBeNull();
    expect(parseStockShipmentRequest({ ...request, cantidad: 1.5 })).toBeNull();
    expect(parseStockShipmentRequest({ ...request, destinoSedeId: 'sede-invalida' })).toBeNull();
    expect(parseStockShipmentRequest({ ...request, motivo: '  ' })).toBeNull();
    expect(parseStockShipmentRequest({ ...request, idempotencyKey: 'not-a-uuid' })).toBeNull();
  });
});

describe('executeStockShipment idempotency', () => {
  const actor = {
    id: '11111111-1111-4111-8111-111111111111',
    username: 'operador',
    role: 'operator' as const,
    areaId: null,
    areaNombre: null,
  };
  const request = {
    expectedActorId: '11111111-1111-4111-8111-111111111111',
    idempotencyKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    insumoId: 'stock-central',
    destinoSedeId: '22222222-2222-4222-8222-222222222222',
    cantidad: 3,
    motivo: 'Reposición',
  };

  it('processes a normal shipment exactly once', async () => {
    const pool = new FakeStockShipmentPool();

    const result = await executeStockShipment(pool.asPool(), request, actor);

    expect(result.alreadyProcessed).toBe(false);
    expect(pool.current.payload.stock[0]?.['cantidadDisponible']).toBe(7);
    expect(pool.current.payload.historial).toHaveLength(1);
    expect(pool.shipments.size).toBe(1);
    expect(pool.auditEvents).toHaveLength(1);
    expect(pool.auditEvents[0]).toMatchObject({
      action: 'Envió stock desde Casa Central a una delegación',
      entity_type: 'transferencia de stock',
    });
  });

  it('rejects a shipment when the authenticated operator changed', async () => {
    const pool = new FakeStockShipmentPool();
    const differentActor = { ...actor, id: '33333333-3333-4333-8333-333333333333' };

    await expect(executeStockShipment(pool.asPool(), request, differentActor)).rejects.toThrow(
      'La sesión autenticada cambió desde que se confirmó el envío.',
    );

    expect(pool.shipments.size).toBe(0);
    expect(pool.current.payload.stock[0]?.['cantidadDisponible']).toBe(10);
  });

  it('applies a shipment once and returns the original movement on retry', async () => {
    const pool = new FakeStockShipmentPool();

    const first = await executeStockShipment(pool.asPool(), request, actor);
    const retry = await executeStockShipment(pool.asPool(), request, actor);

    expect(first.alreadyProcessed).toBe(false);
    expect(retry).toMatchObject({
      alreadyProcessed: true,
      movementId: first.movementId,
    });
    expect(pool.current.payload.stock[0]?.['cantidadDisponible']).toBe(7);
    expect(pool.current.payload.historial).toHaveLength(1);
    expect(pool.auditEvents).toHaveLength(2);
    expect(pool.auditEvents[1]).toMatchObject({
      action: 'Reintentó un envío de stock ya procesado',
      entity_type: 'reintento de envío de stock',
      entity_id: first.movementId,
    });
  });

  it('rejects a repeated key when the request content differs', async () => {
    const pool = new FakeStockShipmentPool();
    await executeStockShipment(pool.asPool(), request, actor);

    await expect(
      executeStockShipment(pool.asPool(), { ...request, cantidad: 4 }, actor),
    ).rejects.toBeInstanceOf(StockShipmentIdempotencyConflictError);
    expect(pool.current.payload.stock[0]?.['cantidadDisponible']).toBe(7);
    expect(pool.current.payload.historial).toHaveLength(1);
  });

  it('serializes simultaneous requests with the same key into one movement', async () => {
    const pool = new FakeStockShipmentPool();

    const [first, second] = await Promise.all([
      executeStockShipment(pool.asPool(), request, actor),
      executeStockShipment(pool.asPool(), request, actor),
    ]);

    expect([first.alreadyProcessed, second.alreadyProcessed].sort()).toEqual([false, true]);
    expect(first.movementId).toBe(second.movementId);
    expect(pool.current.payload.stock[0]?.['cantidadDisponible']).toBe(7);
    expect(pool.current.payload.historial).toHaveLength(1);
  });

  it('rolls back the snapshot and idempotency key when the transaction fails', async () => {
    const pool = new FakeStockShipmentPool();
    pool.failSnapshotUpdate = true;

    await expect(executeStockShipment(pool.asPool(), request, actor)).rejects.toThrow(
      'simulated snapshot update failure',
    );
    expect(pool.current.payload.stock[0]?.['cantidadDisponible']).toBe(10);
    expect(pool.current.payload.historial).toHaveLength(0);
    expect(pool.shipments.size).toBe(0);
  });

  it('rolls back the shipment when its canonical audit event cannot be inserted', async () => {
    const pool = new FakeStockShipmentPool();
    pool.failAuditInsert = true;

    await expect(executeStockShipment(pool.asPool(), request, actor)).rejects.toThrow(
      'simulated audit insert failure',
    );
    expect(pool.current.payload.stock[0]?.['cantidadDisponible']).toBe(10);
    expect(pool.current.payload.historial).toHaveLength(0);
    expect(pool.shipments.size).toBe(0);
    expect(pool.auditEvents).toHaveLength(0);
  });

  it('allows the same shipment details under a new key as a separate operation', async () => {
    const pool = new FakeStockShipmentPool();
    const first = await executeStockShipment(pool.asPool(), request, actor);
    const second = await executeStockShipment(
      pool.asPool(),
      { ...request, idempotencyKey: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      actor,
    );

    expect(first.movementId).not.toBe(second.movementId);
    expect(second.alreadyProcessed).toBe(false);
    expect(pool.current.payload.stock[0]?.['cantidadDisponible']).toBe(4);
    expect(pool.current.payload.historial).toHaveLength(2);
  });
});

describe('applyStockShipment', () => {
  const actor = {
    id: '11111111-1111-4111-8111-111111111111',
    username: 'operador',
    role: 'operator' as const,
    areaId: null,
    areaNombre: null,
  };
  const request = {
    expectedActorId: '11111111-1111-4111-8111-111111111111',
    idempotencyKey: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    insumoId: 'stock-central',
    destinoSedeId: '22222222-2222-4222-8222-222222222222',
    cantidad: 3,
    motivo: 'Reposición',
  };

  it('decrements Casa Central, credits the delegation, and attributes the audit movement', () => {
    const snapshot: InventorySnapshot = {
      pisos: [],
      areas: [],
      stock: [
        {
          id: 'stock-central',
          tipo: 'RAM',
          marca: 'Kingston',
          especificacion: '8 GB',
          cantidadDisponible: 10,
          stockMinimo: 2,
          sedeId: '00000000-0000-4000-8000-000000000001',
        },
      ],
      puestos: [],
      equiposRed: [],
      componentesRetirados: [],
      historial: [],
    };

    const result = applyStockShipment(snapshot, request, 'Delegación Norte', actor);

    expect(
      result.stock.find((item) => item['id'] === 'stock-central')?.['cantidadDisponible'],
    ).toBe(7);
    expect(result.stock).toContainEqual(
      expect.objectContaining({
        tipo: 'RAM',
        marca: 'Kingston',
        cantidadDisponible: 3,
        stockMinimo: 2,
        sedeId: request.destinoSedeId,
      }),
    );
    expect(result.historial[0]).toMatchObject({
      tipo: 'TRANSFERENCIA_STOCK',
      cantidad: 3,
      sedeId: '00000000-0000-4000-8000-000000000001',
      sedeDestinoId: request.destinoSedeId,
      operadorId: actor.id,
      operador: actor.username,
    });
    expect(snapshot.stock[0]?.['cantidadDisponible']).toBe(10);
  });

  it('adds transferred quantity to an existing matching product at the destination', () => {
    const snapshot: InventorySnapshot = {
      pisos: [],
      areas: [],
      stock: [
        {
          id: 'stock-central',
          tipo: 'RAM',
          marca: 'Kingston',
          especificacion: '8 GB',
          cantidadDisponible: 10,
          stockMinimo: 2,
          sedeId: '00000000-0000-4000-8000-000000000001',
        },
        {
          id: 'stock-destination',
          tipo: 'RAM',
          marca: 'Kingston',
          especificacion: '8 GB',
          cantidadDisponible: 4,
          stockMinimo: 1,
          sedeId: request.destinoSedeId,
        },
      ],
      puestos: [],
      equiposRed: [],
      componentesRetirados: [],
      historial: [],
    };

    const result = applyStockShipment(snapshot, request, 'Delegación Norte', actor);

    expect(
      result.stock.find((item) => item['id'] === 'stock-destination')?.['cantidadDisponible'],
    ).toBe(7);
    expect(result.stock).toHaveLength(2);
  });

  it('rejects shipments greater than the Casa Central balance', () => {
    const snapshot: InventorySnapshot = {
      pisos: [],
      areas: [],
      stock: [
        {
          id: 'stock-central',
          tipo: 'RAM',
          marca: 'Kingston',
          especificacion: '8 GB',
          cantidadDisponible: 2,
          stockMinimo: 0,
          sedeId: '00000000-0000-4000-8000-000000000001',
        },
      ],
      puestos: [],
      equiposRed: [],
      componentesRetirados: [],
      historial: [],
    };

    expect(() => applyStockShipment(snapshot, request, 'Delegación Norte', actor)).toThrow(
      StockShipmentValidationError,
    );
  });
});

describe('areDelegationStockChangesValid', () => {
  const delegatedStock = {
    id: 'stock-delegation',
    tipo: 'RAM',
    marca: 'Kingston',
    especificacion: '8 GB',
    cantidadDisponible: 4,
    stockMinimo: 1,
    sedeId: '22222222-2222-4222-8222-222222222222',
  };
  const current: InventorySnapshot = {
    pisos: [],
    areas: [],
    stock: [delegatedStock],
    puestos: [],
    equiposRed: [],
    componentesRetirados: [],
    historial: [],
  };

  it('rejects direct additions or transfers into a delegation through inventory save', () => {
    expect(
      areDelegationStockChangesValid(current, {
        ...current,
        stock: [{ ...delegatedStock, cantidadDisponible: 7 }],
        historial: [],
      }),
    ).toBe(false);
    expect(
      areDelegationStockChangesValid(
        { ...current, stock: [] },
        { ...current, stock: [delegatedStock] },
      ),
    ).toBe(false);
    expect(
      areDelegationStockChangesValid(current, {
        ...current,
        stock: [{ ...delegatedStock, sedeId: '00000000-0000-4000-8000-000000000001' }],
      }),
    ).toBe(false);
  });

  it('allows a delegated balance increase only when it is a recorded stock adjustment', () => {
    expect(
      areDelegationStockChangesValid(current, {
        ...current,
        stock: [{ ...delegatedStock, cantidadDisponible: 7 }],
        historial: [
          {
            id: 'adjustment-1',
            tipo: 'AJUSTE_STOCK',
            insumoId: delegatedStock.id,
            sedeId: delegatedStock.sedeId,
            cantidad: 3,
          },
        ],
      }),
    ).toBe(true);
    expect(
      areDelegationStockChangesValid(current, {
        ...current,
        stock: [{ ...delegatedStock, cantidadDisponible: 7 }],
        historial: [],
      }),
    ).toBe(false);
    expect(
      areDelegationStockChangesValid(current, {
        ...current,
        stock: [{ ...delegatedStock, cantidadDisponible: -1 }],
        historial: [],
      }),
    ).toBe(false);
  });
});

describe('parseComponentEdit', () => {
  it('accepts and trims editable component fields without accepting an ID', () => {
    expect(
      parseComponentEdit({
        tipo: 'MONITOR',
        marca: ' Dell ',
        modelo: ' P2422H ',
        especificacion: ' 24 pulgadas ',
        numeroSerie: ' SN-1 ',
        codigoSeguimiento: ' COMP-1 ',
      }),
    ).toEqual({
      tipo: 'MONITOR',
      marca: 'Dell',
      modelo: 'P2422H',
      especificacion: '24 pulgadas',
      numeroSerie: 'SN-1',
      codigoSeguimiento: 'COMP-1',
    });
    expect(
      parseComponentEdit({
        id: 'otro-id',
        tipo: 'MONITOR',
        marca: 'Dell',
        especificacion: '24 pulgadas',
      }),
    ).toBeNull();
  });

  it('rejects invalid component types and incomplete required values', () => {
    expect(
      parseComponentEdit({ tipo: 'INVENTED', marca: 'Dell', especificacion: '24' }),
    ).toBeNull();
    expect(parseComponentEdit({ tipo: 'MONITOR', marca: ' ', especificacion: '24' })).toBeNull();
  });
});

describe('areExistingComponentsUnchanged', () => {
  const component = { id: 'component-1', tipo: 'MONITOR', marca: 'Dell', especificacion: '24' };

  it('rejects edits to existing component fields even when the ID is unchanged', () => {
    expect(
      areExistingComponentsUnchanged(
        snapshotWithComponent(component),
        snapshotWithComponent({ ...component, marca: 'Lenovo' }),
      ),
    ).toBe(false);
  });

  it('allows additions and permits deletion only for administrators', () => {
    const emptySnapshot: InventorySnapshot = {
      pisos: [],
      areas: [],
      stock: [],
      puestos: [{ id: 'puesto-1', componentes: [] }],
      equiposRed: [],
      componentesRetirados: [],
      historial: [],
    };
    expect(
      areExistingComponentsUnchanged(
        emptySnapshot,
        snapshotWithComponent({ id: 'new-component', tipo: 'MONITOR' }),
      ),
    ).toBe(true);
    expect(areExistingComponentsUnchanged(snapshotWithComponent(component), emptySnapshot)).toBe(
      false,
    );
    expect(
      areExistingComponentsUnchanged(snapshotWithComponent(component), emptySnapshot, true),
    ).toBe(true);
  });

  it('allows retiring an existing component without changing its data', () => {
    const retiredSnapshot: InventorySnapshot = {
      pisos: [],
      areas: [],
      stock: [],
      puestos: [{ id: 'puesto-1', componentes: [] }],
      equiposRed: [],
      componentesRetirados: [{ id: 'retired-1', componente: component }],
      historial: [],
    };
    expect(areExistingComponentsUnchanged(snapshotWithComponent(component), retiredSnapshot)).toBe(
      true,
    );
  });
});

describe('parsePasswordReset', () => {
  it('accepts a password that meets the minimum length', () => {
    expect(parsePasswordReset({ password: 'a-secure-password' })).toBe('a-secure-password');
  });

  describe('createLoginFailureKey', () => {
    it('isolates accounts sharing an IP and normalizes username casing and whitespace', () => {
      expect(createLoginFailureKey('192.0.2.10', ' Admin ')).toBe(
        createLoginFailureKey('192.0.2.10', 'admin'),
      );
      expect(createLoginFailureKey('192.0.2.10', 'admin')).not.toBe(
        createLoginFailureKey('192.0.2.10', 'operator'),
      );
      expect(createLoginFailureKey('192.0.2.10', 'admin')).not.toBe(
        createLoginFailureKey('192.0.2.11', 'admin'),
      );
    });
  });

  it('rejects missing, short, or non-string passwords', () => {
    expect(parsePasswordReset(null)).toBeNull();
    expect(parsePasswordReset({})).toBeNull();
    expect(parsePasswordReset({ password: 'short' })).toBeNull();
    expect(parsePasswordReset({ password: 123456789012 })).toBeNull();
  });
});

describe('parseManagedUserUpdate', () => {
  it('accepts a role and active-area identifier without exposing username changes', () => {
    expect(
      parseManagedUserUpdate({
        username: 'different-name',
        role: 'solicitante',
        areaId: '00000000-0000-4000-8000-000000000001',
      }),
    ).toEqual({
      role: 'solicitante',
      areaId: '00000000-0000-4000-8000-000000000001',
    });
  });

  it('requires an area for requesters and rejects areas for other roles', () => {
    expect(parseManagedUserUpdate({ role: 'solicitante', areaId: null })).toBeNull();
    expect(
      parseManagedUserUpdate({
        role: 'operator',
        areaId: '00000000-0000-4000-8000-000000000001',
      }),
    ).toBeNull();
    expect(parseManagedUserUpdate({ role: 'invalid', areaId: null })).toBeNull();
  });
});

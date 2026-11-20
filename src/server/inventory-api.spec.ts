import {
  applyStockShipment,
  attributeHistoryOperators,
  areDelegationStockChangesValid,
  areExistingComponentsUnchanged,
  createLoginFailureKey,
  normalizeSnapshot,
  parseComponentEdit,
  parseManagedUserUpdate,
  parsePasswordReset,
  parseStockShipmentRequest,
  StockShipmentValidationError,
  type InventorySnapshot,
} from './inventory-api';

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
  it('accepts a complete shipment request and trims its text fields', () => {
    expect(
      parseStockShipmentRequest({
        insumoId: ' stock-1 ',
        destinoSedeId: '11111111-1111-4111-8111-111111111111',
        cantidad: 3,
        motivo: ' Reposición ',
      }),
    ).toEqual({
      insumoId: 'stock-1',
      destinoSedeId: '11111111-1111-4111-8111-111111111111',
      cantidad: 3,
      motivo: 'Reposición',
    });
  });

  it('rejects invalid quantities, destinations, and missing reasons', () => {
    const request = {
      insumoId: 'stock-1',
      destinoSedeId: '11111111-1111-4111-8111-111111111111',
      cantidad: 3,
      motivo: 'Reposición',
    };
    expect(parseStockShipmentRequest({ ...request, cantidad: 0 })).toBeNull();
    expect(parseStockShipmentRequest({ ...request, cantidad: 1.5 })).toBeNull();
    expect(parseStockShipmentRequest({ ...request, destinoSedeId: 'sede-invalida' })).toBeNull();
    expect(parseStockShipmentRequest({ ...request, motivo: '  ' })).toBeNull();
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

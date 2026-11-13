import { describeInventoryChange, inventoryHistoryAuditEvents } from './operator-audit';

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
});

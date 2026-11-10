import { describeInventoryChange } from './operator-audit';

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

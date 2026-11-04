import {
  areExistingComponentsUnchanged,
  createLoginFailureKey,
  normalizeSnapshot,
  parseComponentEdit,
  parsePasswordReset,
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

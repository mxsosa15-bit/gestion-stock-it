import type { InventorySnapshot } from './inventory-api';
import {
  applyInventoryTransfer,
  parseTransferRequest,
} from './inventory-transfers-api';

const inventory: InventorySnapshot = {
  pisos: [
    { id: 'floor-1', nombre: 'Piso 1' },
    { id: 'floor-2', nombre: 'Piso 2' },
  ],
  areas: [
    { id: 'area-a', pisoId: 'floor-1', nombre: 'Personal' },
    { id: 'area-b', pisoId: 'floor-2', nombre: 'Informática' },
  ],
  personas: [
    { id: 'person-1', nombre: 'Maxi', areaId: 'area-a', puestoId: 'desk-a' },
  ],
  stock: [],
  puestos: [
    {
      id: 'desk-a',
      areaId: 'area-a',
      nombrePuesto: 'Puesto Personal',
      usuarioAsignado: 'Maxi',
      codigoSeguimiento: 'PUESTO-A',
      componentes: [
        {
          id: 'monitor-a',
          tipo: 'MONITOR',
          marca: 'Dell',
          especificacion: '24 pulgadas',
        },
      ],
    },
    {
      id: 'desk-b',
      areaId: 'area-b',
      nombrePuesto: 'Puesto Informática',
      usuarioAsignado: '',
      codigoSeguimiento: 'PUESTO-B',
      componentes: [],
    },
  ],
  equiposRed: [
    {
      id: 'switch-a',
      tipo: 'SWITCH',
      marca: 'Cisco',
      modelo: 'CBS110',
      areaId: 'area-a',
      codigoSeguimiento: 'RED-A',
    },
  ],
  componentesRetirados: [],
  historial: [],
};

function request(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    revision: 1,
    origenAreaId: 'area-a',
    destinoAreaId: 'area-b',
    destinoPuestoId: 'desk-b',
    nuevoPuesto: null,
    personaIds: [],
    componentes: [],
    equipoRedIds: [],
    moverAreaCompleta: false,
    destinoPisoId: null,
    descripcion: 'Reorganización',
    ...overrides,
  };
}

describe('parseTransferRequest', () => {
  it('accepts a transfer with a single employee and selected hardware', () => {
    expect(
      parseTransferRequest(
        request({
          personaIds: ['person-1'],
          componentes: [{ puestoId: 'desk-a', componenteId: 'monitor-a' }],
        }),
      ),
    ).toMatchObject({
      origenAreaId: 'area-a',
      destinoAreaId: 'area-b',
      personaIds: ['person-1'],
      componentes: [{ puestoId: 'desk-a', componenteId: 'monitor-a' }],
    });
  });

  it('rejects duplicate entities and missing descriptions', () => {
    expect(
      parseTransferRequest(
        request({ personaIds: ['person-1', 'person-1'] }),
      ),
    ).toBeNull();
    expect(parseTransferRequest(request({ descripcion: '  ' }))).toBeNull();
  });
});

describe('applyInventoryTransfer', () => {
  it('moves an employee without moving the equipment left at the old location', () => {
    const parsed = parseTransferRequest(request({ personaIds: ['person-1'] }));
    expect(parsed).not.toBeNull();
    const result = applyInventoryTransfer(inventory, parsed!);

    expect(result.snapshot.personas).toEqual([
      { id: 'person-1', nombre: 'Maxi', areaId: 'area-b', puestoId: 'desk-b' },
    ]);
    expect(result.snapshot.puestos[0]).toMatchObject({
      id: 'desk-a',
      usuarioAsignado: '',
      componentes: [{ id: 'monitor-a' }],
    });
    expect(result.snapshot.puestos[1]).toMatchObject({
      id: 'desk-b',
      usuarioAsignado: 'Maxi',
    });
    expect(result.movimientos.map((movement) => movement.tipoEntidad)).toEqual(['PERSONA']);
  });

  it('moves an asset while leaving its assigned employee at the origin', () => {
    const parsed = parseTransferRequest(
      request({ componentes: [{ puestoId: 'desk-a', componenteId: 'monitor-a' }] }),
    );
    expect(parsed).not.toBeNull();
    const result = applyInventoryTransfer(inventory, parsed!);

    expect(result.snapshot.puestos[0]).toMatchObject({
      usuarioAsignado: 'Maxi',
      componentes: [],
    });
    expect(result.snapshot.puestos[1]).toMatchObject({
      componentes: [{ id: 'monitor-a' }],
    });
    expect(result.snapshot.personas?.[0]).toMatchObject({
      areaId: 'area-a',
      puestoId: 'desk-a',
    });
  });

  it('moves a whole area to another floor and logs affected people and equipment', () => {
    const parsed = parseTransferRequest(
      request({
        destinoAreaId: 'area-a',
        destinoPuestoId: null,
        moverAreaCompleta: true,
        destinoPisoId: 'floor-2',
        equipoRedIds: [],
      }),
    );
    expect(parsed).not.toBeNull();
    const result = applyInventoryTransfer(inventory, parsed!);

    expect(result.snapshot.areas[0]).toMatchObject({
      id: 'area-a',
      pisoId: 'floor-2',
    });
    expect(result.movimientos.map((movement) => movement.tipoEntidad).sort()).toEqual([
      'AREA',
      'COMPONENTE',
      'EQUIPO_RED',
      'PERSONA',
    ]);
    expect(result.movimientos[1]?.origen['floorId']).toBe('floor-1');
    expect(result.movimientos[1]?.destino['floorId']).toBe('floor-2');
  });

  it('rejects a destination workstation from a different destination area', () => {
    const parsed = parseTransferRequest(
      request({ destinoPuestoId: 'desk-a', personaIds: ['person-1'] }),
    );
    expect(parsed).not.toBeNull();
    expect(() => applyInventoryTransfer(inventory, parsed!)).toThrow(
      'El puesto de destino no pertenece al área seleccionada.',
    );
  });
});

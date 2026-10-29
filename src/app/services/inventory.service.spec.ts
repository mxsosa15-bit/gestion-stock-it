import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { Area, Piso, PuestoTrabajo, StockInsumo } from '../models/inventory.model';
import { InventoryService } from './inventory.service';

describe('InventoryService', () => {
  let service: InventoryService;

  const stock: StockInsumo[] = [
    {
      id: 'ssd-1',
      tipo: 'DISCO_SSD',
      marca: 'Kingston',
      especificacion: 'SSD 480GB SATA3',
      cantidadDisponible: 2,
      stockMinimo: 1,
    },
  ];
  const puestos: PuestoTrabajo[] = [
    {
      id: 'puesto-1',
      areaId: 'area-1',
      nombrePuesto: 'Puesto 1',
      usuarioAsignado: 'María',
      codigoSeguimiento: 'PUESTO-TEST-1',
      componentes: [
        {
          id: 'hdd-1',
          tipo: 'DISCO_HDD',
          marca: 'Western Digital',
          especificacion: '1TB HDD',
        },
      ],
    },
  ];

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [InventoryService, provideHttpClient()],
    });
    service = TestBed.inject(InventoryService);
    service.stock.set(stock);
    service.puestos.set(puestos);
    service.areas.set([{ id: 'area-1', pisoId: 'piso-1', nombre: 'Cajas' } satisfies Area]);
    service.pisos.set([{ id: 'piso-1', nombre: 'Planta Baja', nivel: 0 } satisfies Piso]);
    service.equiposRed.set([]);
    service.componentesRetirados.set([]);
    service.historial.set([]);
  });

  it('replaces a workstation component, deducts stock, and records the movement', () => {
    service.reemplazarComponente('puesto-1', 'hdd-1', 'ssd-1', 'Falla: disco ruidoso');

    expect(service.stock()[0]?.cantidadDisponible).toBe(1);
    expect(service.puestos()[0]?.componentes).toEqual([
      {
        id: expect.stringMatching(/^comp-/),
        tipo: 'DISCO_SSD',
        marca: 'Kingston',
        especificacion: 'SSD 480GB SATA3',
      },
    ]);
    expect(
      service.historial().find((movimiento) => movimiento.tipo === 'REEMPLAZO_PUESTO'),
    ).toMatchObject({
      tipo: 'REEMPLAZO_PUESTO',
      insumoId: 'ssd-1',
      puestoId: 'puesto-1',
      cantidad: 1,
    });
    expect(service.historial()[0]?.fecha).toBeInstanceOf(Date);
    expect(service.historial().find((movimiento) => movimiento.tipo === 'REEMPLAZO_PUESTO')?.detalle)
      .toContain('Motivo: Falla: disco ruidoso.');
    expect(service.componentesRetirados()).toHaveLength(1);
    expect(service.componentesRetirados()[0]).toMatchObject({
      puestoId: 'puesto-1',
      estado: 'REPARACION',
      componente: {
        id: 'hdd-1',
        tipo: 'DISCO_HDD',
        marca: 'Western Digital',
      },
    });
    expect(service.componentesRetirados()[0]?.fechaRetiro).toBeInstanceOf(Date);
  });

  it('does not change stock when there is no available item', () => {
    service.stock.set([{ ...stock[0]!, cantidadDisponible: 0 }]);

    expect(() => service.reemplazarComponente('puesto-1', 'hdd-1', 'ssd-1', 'Falla')).toThrow(
      'No hay suficiente stock disponible',
    );
    expect(service.puestos()).toEqual(puestos);
    expect(service.historial()).toHaveLength(0);
  });

  it('creates and removes network equipment while deferring its tracking code to the server', () => {
    const equipo = service.crearEquipoRed({
      tipo: 'SWITCH',
      marca: 'Cisco',
      modelo: 'CBS110',
      areaId: 'area-1',
    });

    expect(equipo.codigoSeguimiento).toBe('');
    expect(equipo.id).toMatch(
      /^red-[^-]+-\d+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(service.equiposRed()).toContainEqual(equipo);

    service.eliminarEquipoRed(equipo.id);

    expect(service.equiposRed()).toEqual([]);
    expect(service.historial().map((movimiento) => movimiento.tipo)).toEqual([
      'BAJA_EQUIPO_RED',
      'ALTA_EQUIPO_RED',
    ]);
  });

  it('leaves tracking-code assignment to the server', () => {
    service.agregarInsumoStock({
      tipo: 'MONITOR',
      marca: 'Samsung',
      especificacion: '24 pulgadas',
      cantidadDisponible: 1,
      stockMinimo: 1,
    });
    service.agregarInsumoStock({
      tipo: 'RAM',
      marca: 'Kingston',
      especificacion: '16GB DDR4',
      cantidadDisponible: 1,
      stockMinimo: 1,
    });

    const monitor = service.stock().find((item) => item.tipo === 'MONITOR');
    const ram = service.stock().find((item) => item.tipo === 'RAM');
    const puesto = service.crearPuestoTrabajo({
      areaId: 'area-1',
      nombrePuesto: 'Puesto 2',
      usuarioAsignado: 'Juan',
      componentes: [
        {
          id: 'monitor-1',
          tipo: 'MONITOR',
          marca: 'Samsung',
          especificacion: '22 pulgadas',
        },
        {
          id: 'ram-1',
          tipo: 'RAM',
          marca: 'Kingston',
          especificacion: '8GB DDR4',
        },
      ],
    });

    expect(monitor?.codigoSeguimiento).toBeUndefined();
    expect(ram).not.toHaveProperty('codigoSeguimiento');
    expect(puesto.codigoSeguimiento).toBe('');
    expect(puesto.componentes[0]?.codigoSeguimiento).toBeUndefined();
    expect(puesto.componentes[1]).not.toHaveProperty('codigoSeguimiento');
    expect(service.personas()).toContainEqual(
      expect.objectContaining({
        nombre: 'Juan',
        areaId: 'area-1',
        puestoId: puesto.id,
      }),
    );
  });

  it('creates a person automatically with a workstation and prevents duplicate assignments', () => {
    const created = service.crearPuestoTrabajo({
      areaId: 'area-1',
      nombrePuesto: 'Puesto nuevo',
      usuarioAsignado: 'Juan',
      componentes: [],
    });

    expect(service.personas()).toContainEqual({
      id: expect.stringMatching(/^persona-/),
      nombre: 'Juan',
      areaId: 'area-1',
      puestoId: created.id,
    });
    expect(() =>
      service.crearPuestoTrabajo({
        areaId: 'area-1',
        nombrePuesto: 'Puesto duplicado',
        usuarioAsignado: 'JUAN',
        componentes: [],
      }),
    ).toThrow('Usá Transferencias para reubicarla.');
    expect(service.puestos()).toHaveLength(2);
  });

  it('adds surveyed components without changing stock and defers external codes to the server', () => {
    const stockInicial = service.stock();
    const monitor = service.agregarComponenteManual('puesto-1', {
      tipo: 'MONITOR',
      marca: 'Dell',
      modelo: 'P2419H',
      especificacion: '24 pulgadas · SN-123',
    });
    const gabinete = service.agregarComponenteManual('puesto-1', {
      tipo: 'GABINETE',
      marca: 'Sentey',
      modelo: 'F10',
      especificacion: 'ATX · SN-456',
    });

    expect(monitor.codigoSeguimiento).toBeUndefined();
    expect(gabinete).not.toHaveProperty('codigoSeguimiento');
    expect(service.puestos()[0]?.componentes).toEqual([
      puestos[0]!.componentes[0],
      monitor,
      gabinete,
    ]);
    expect(service.stock()).toEqual(stockInicial);
    expect(service.historial().map((movimiento) => movimiento.tipo)).toEqual([
      'ALTA_COMPONENTE',
      'ALTA_COMPONENTE',
    ]);
  });

  it('rejects manual component registration for a missing workstation', () => {
    expect(() =>
      service.agregarComponenteManual('missing', {
        tipo: 'MOUSE',
        marca: 'Logitech',
        modelo: 'M185',
        especificacion: 'Wireless',
      }),
    ).toThrow('No se encontró el puesto');
    expect(service.stock()).toEqual(stock);
  });

  it('changes the status of a removed component', () => {
    service.reemplazarComponente('puesto-1', 'hdd-1', 'ssd-1', 'Obsolescencia');
    const retirado = service.componentesRetirados()[0];

    expect(retirado).toBeDefined();
    service.cambiarEstadoComponenteRetirado(retirado!.id, 'SCRAP');

    expect(service.componentesRetirados()[0]?.estado).toBe('SCRAP');
    expect(service.historial()[0]?.tipo).toBe('CAMBIO_ESTADO_COMPONENTE');
  });
});

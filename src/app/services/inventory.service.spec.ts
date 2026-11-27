import { TestBed } from '@angular/core/testing';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { Area, Piso, PuestoTrabajo, StockInsumo } from '../models/inventory.model';
import { InventoryService } from './inventory.service';

describe('InventoryService', () => {
  let service: InventoryService;
  let httpTesting: HttpTestingController;

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
      providers: [InventoryService, provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(InventoryService);
    httpTesting = TestBed.inject(HttpTestingController);
    service.stock.set(stock);
    service.puestos.set(puestos);
    service.areas.set([{ id: 'area-1', pisoId: 'piso-1', nombre: 'Cajas' } satisfies Area]);
    service.pisos.set([{ id: 'piso-1', nombre: 'Planta Baja', nivel: 0 } satisfies Piso]);
    service.equiposRed.set([]);
    service.componentesRetirados.set([]);
    service.historial.set([]);
  });

  afterEach(() => httpTesting.verify());

  it('serializes saves and keeps edits made while a save is in flight', async () => {
    const firstSave = service.guardarEnServidor();
    const firstRequest = httpTesting.expectOne('/api/inventory');
    const firstPayload = firstRequest.request.body.payload;

    service.stock.update((items) =>
      items.map((item) => ({ ...item, cantidadDisponible: 7 })),
    );
    const secondSave = service.guardarEnServidor();

    firstRequest.flush({ revision: '1', payload: firstPayload });
    await firstSave;
    await Promise.resolve();

    const secondRequest = httpTesting.expectOne('/api/inventory');
    expect(secondRequest.request.body.revision).toBe(1);
    expect(secondRequest.request.body.payload.stock[0].cantidadDisponible).toBe(7);
    secondRequest.flush({
      revision: '2',
      payload: secondRequest.request.body.payload,
    });
    await secondSave;

    expect(service.stock()[0]?.cantidadDisponible).toBe(7);
  });

  it('preserves the local draft and blocks saves after a revision conflict', async () => {
    service.stock.set([{ ...stock[0]!, cantidadDisponible: 5 }]);
    const save = service.guardarEnServidor();
    const request = httpTesting.expectOne('/api/inventory');
    const remotePayload = {
      pisos: [],
      areas: [],
      personas: [],
      stock: [{ ...stock[0]!, cantidadDisponible: 1 }],
      puestos: [],
      equiposRed: [],
      componentesRetirados: [],
      historial: [],
    };

    request.flush(
      { revision: '4', payload: remotePayload },
      { status: 409, statusText: 'Conflict' },
    );
    await expect(save).rejects.toThrow('Tus cambios locales se conservaron');

    expect(service.stock()[0]?.cantidadDisponible).toBe(5);
    expect(service.conflictoInventario()).toMatchObject({ revision: '4' });
    await expect(service.guardarEnServidor()).rejects.toThrow('resolvé el conflicto');
    expect(httpTesting.match('/api/inventory')).toHaveLength(0);

    const combinedPayload = {
      ...remotePayload,
      areas: [{ id: 'area-remota', pisoId: 'piso-remoto', nombre: 'Área preservada' }],
      stock: [{ ...stock[0]!, cantidadDisponible: 5 }],
    };
    const resolution = service.resolverConflictoConRespaldo({
      format: 'gestion-it-backup',
      version: 1,
      createdAt: new Date().toISOString(),
      inventory: combinedPayload,
    });
    await Promise.resolve();
    const resolutionRequest = httpTesting.expectOne('/api/inventory');
    expect(resolutionRequest.request.body.revision).toBe(4);
    expect(resolutionRequest.request.body.payload).toEqual(combinedPayload);
    resolutionRequest.flush({ revision: '5', payload: combinedPayload });
    await resolution;
    expect(service.conflictoInventario()).toBeNull();
  });

  it('preserves the local draft after a non-conflict server error', async () => {
    service.stock.set([{ ...stock[0]!, cantidadDisponible: 6 }]);
    const save = service.guardarEnServidor();

    httpTesting.expectOne('/api/inventory').flush(
      { error: 'server error' },
      { status: 500, statusText: 'Server Error' },
    );
    await expect(save).rejects.toThrow();

    expect(service.stock()[0]?.cantidadDisponible).toBe(6);
  });

  it('edits stock metadata and workstation assignment without changing balances or location IDs', () => {
    service.stock.set([
      {
        ...stock[0]!,
        codigoSeguimiento: 'STOCK-001',
        sedeId: '00000000-0000-4000-8000-000000000001',
      },
    ]);

    service.editarProductoStock('ssd-1', {
      tipo: 'DISCO_SSD',
      marca: 'Kingston Technology',
      especificacion: 'SSD 480GB SATA3',
      stockMinimo: 3,
    });
    service.editarPuestoTrabajo('puesto-1', {
      nombrePuesto: 'Puesto 1 corregido',
      usuarioAsignado: 'María Pérez',
    });

    expect(service.stock()[0]).toMatchObject({
      id: 'ssd-1',
      marca: 'Kingston Technology',
      cantidadDisponible: 2,
      stockMinimo: 3,
      codigoSeguimiento: 'STOCK-001',
      sedeId: '00000000-0000-4000-8000-000000000001',
    });
    expect(service.puestos()[0]).toMatchObject({
      id: 'puesto-1',
      areaId: 'area-1',
      codigoSeguimiento: 'PUESTO-TEST-1',
      nombrePuesto: 'Puesto 1 corregido',
      usuarioAsignado: 'María Pérez',
      componentes: puestos[0]!.componentes,
    });
    expect(service.personas()).toContainEqual(
      expect.objectContaining({
        nombre: 'María Pérez',
        areaId: 'area-1',
        puestoId: 'puesto-1',
      }),
    );
  });

  it('updates component fields through the administrative endpoint and preserves the ID', async () => {
    const savedInventory = {
      pisos: [],
      areas: [],
      personas: [],
      stock: [],
      puestos: [
        {
          ...puestos[0]!,
          componentes: [
            {
              id: 'hdd-1',
              tipo: 'DISCO_HDD',
              marca: 'Western Digital',
              especificacion: '2TB HDD',
              numeroSerie: 'SN-2',
            },
          ],
        },
      ],
      equiposRed: [],
      componentesRetirados: [],
      historial: [],
    };
    const edit = service.editarComponenteAdministrativamente(
      'puesto-1',
      'hdd-1',
      {
        tipo: 'DISCO_HDD',
        marca: 'Western Digital',
        especificacion: '2TB HDD',
        numeroSerie: 'SN-2',
      },
      'Corrección de carga',
    );
    const request = httpTesting.expectOne('/api/inventory/puestos/puesto-1/componentes/hdd-1');
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({
      revision: 0,
      changes: {
        tipo: 'DISCO_HDD',
        marca: 'Western Digital',
        especificacion: '2TB HDD',
        numeroSerie: 'SN-2',
      },
      reason: 'Corrección de carga',
    });
    request.flush({ revision: '1', payload: savedInventory });
    await edit;

    expect(service.puestos()[0]?.componentes[0]).toMatchObject({
      id: 'hdd-1',
      especificacion: '2TB HDD',
      numeroSerie: 'SN-2',
    });
  });

  it('sends the stable idempotency key and applies the inventory returned by the server', async () => {
    const idempotencyKey = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const shipment = service.enviarStockADelegacion(
      'ssd-1',
      '11111111-1111-4111-8111-111111111111',
      2,
      'Reposición',
      idempotencyKey,
      '11111111-1111-4111-8111-111111111111',
    );
    const request = httpTesting.expectOne('/api/inventory/stock-transfers');

    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({
      insumoId: 'ssd-1',
      destinoSedeId: '11111111-1111-4111-8111-111111111111',
      cantidad: 2,
      motivo: 'Reposición',
      idempotencyKey,
      expectedActorId: '11111111-1111-4111-8111-111111111111',
    });
    request.flush({
      revision: '2',
      payload: {
        pisos: [],
        areas: [],
        personas: [],
        stock: [{ ...stock[0]!, cantidadDisponible: 0 }],
        puestos: [],
        equiposRed: [],
        componentesRetirados: [],
        historial: [],
      },
      idempotencyKey,
      movementId: 'hist-original',
      alreadyProcessed: true,
    });

    await expect(shipment).resolves.toEqual({ alreadyProcessed: true });
    expect(service.stock()[0]?.cantidadDisponible).toBe(0);
  });

  it('keeps timeout outcomes uncertain but recognizes a rolled-back shipment rejection', async () => {
    const timedOutShipment = service.enviarStockADelegacion(
      'ssd-1',
      '11111111-1111-4111-8111-111111111111',
      2,
      'Reposición',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '11111111-1111-4111-8111-111111111111',
    );
    httpTesting
      .expectOne('/api/inventory/stock-transfers')
      .flush(
        { code: 'UPSTREAM_TIMEOUT', error: 'Request timed out.' },
        { status: 408, statusText: 'Request Timeout' },
      );
    await expect(timedOutShipment).rejects.toMatchObject({
      status: 408,
      outcomeUnknown: true,
    });

    const rejectedShipment = service.enviarStockADelegacion(
      'ssd-1',
      '11111111-1111-4111-8111-111111111111',
      20,
      'Reposición',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      '11111111-1111-4111-8111-111111111111',
    );
    await Promise.resolve();
    httpTesting
      .expectOne('/api/inventory/stock-transfers')
      .flush(
        { code: 'SHIPMENT_REJECTED', error: 'Insufficient stock.' },
        { status: 400, statusText: 'Bad Request' },
      );
    await expect(rejectedShipment).rejects.toMatchObject({
      status: 400,
      code: 'SHIPMENT_REJECTED',
      outcomeUnknown: false,
    });
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
    expect(
      service.historial().find((movimiento) => movimiento.tipo === 'REEMPLAZO_PUESTO')?.detalle,
    ).toContain('Motivo: Falla: disco ruidoso.');
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

  it('registers opening stock as an exact balance instead of adding it', () => {
    service.registrarSaldoInicial({
      tipo: 'DISCO_SSD',
      marca: 'Kingston',
      especificacion: 'SSD 500GB',
      cantidadDisponible: 17,
      stockMinimo: 3,
    });

    expect(service.stock().find((item) => item.especificacion === 'SSD 500GB')).toMatchObject({
      cantidadDisponible: 17,
      sedeId: '00000000-0000-4000-8000-000000000001',
    });
    expect(service.historial()[0]).toMatchObject({
      tipo: 'SALDO_INICIAL',
      cantidad: 17,
    });
  });

  it('adjusts to the counted balance and requires an auditable reason', () => {
    service.ajustarStock('ssd-1', 17, 'Se consumieron 3 unidades antes de la carga inicial');

    expect(service.stock()[0]?.cantidadDisponible).toBe(17);
    expect(service.historial()[0]).toMatchObject({
      tipo: 'AJUSTE_STOCK',
      cantidad: 15,
    });
    expect(service.historial()[0]?.detalle).toContain('2 → 17');
    expect(() => service.ajustarStock('ssd-1', -1, 'Conteo')).toThrow(
      'La cantidad real debe ser un entero igual o mayor que cero.',
    );
    expect(() => service.ajustarStock('ssd-1', 17, '')).toThrow('Indicá un motivo de ajuste');
  });

  it('keeps otherwise identical stock products separate by location', () => {
    service.agregarInsumoStock(
      {
        tipo: 'DISCO_SSD',
        marca: 'Kingston',
        especificacion: 'SSD 480GB SATA3',
        cantidadDisponible: 4,
        stockMinimo: 1,
      },
      '11111111-1111-4111-8111-111111111111',
    );

    expect(service.stock()).toHaveLength(2);
    expect(service.stock()[0]?.cantidadDisponible).toBe(2);
    expect(service.stock()[1]).toMatchObject({
      cantidadDisponible: 4,
      sedeId: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('does not block a same-named person assigned in a different location', () => {
    service.pisos.set([
      { id: 'piso-1', nombre: 'Planta Baja', nivel: 0 },
      {
        id: 'piso-remoto',
        nombre: 'Oficina',
        nivel: 0,
        sedeId: '11111111-1111-4111-8111-111111111111',
      },
    ]);
    service.areas.set([
      { id: 'area-1', pisoId: 'piso-1', nombre: 'Cajas' },
      { id: 'area-remota', pisoId: 'piso-remoto', nombre: 'General' },
    ]);
    service.personas.set([
      { id: 'persona-central', nombre: 'Juan Pérez', areaId: 'area-1', puestoId: null },
    ]);

    const remoteWorkstation = service.crearPuestoTrabajo({
      areaId: 'area-remota',
      nombrePuesto: 'Puesto remoto',
      usuarioAsignado: 'Juan Pérez',
      componentes: [],
    });

    expect(remoteWorkstation.usuarioAsignado).toBe('Juan Pérez');
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

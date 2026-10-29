import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { vi } from 'vitest';
import { App } from './app';

describe('App', () => {
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  function createApp() {
    const fixture = TestBed.createComponent(App);
    httpMock.expectOne('/api/auth/session').flush({
      authenticated: false,
      user: null,
      setupRequired: false,
    });
    return fixture;
  }

  it('should create the app', () => {
    const fixture = createApp();
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('should render title', async () => {
    const fixture = createApp();
    await fixture.whenStable();
    expect(fixture.componentInstance.tituloVista()).toBe('Dashboard operativo');
  });

  it('keeps the existing card view as default and supports switching to the list', () => {
    const fixture = createApp();
    const app = fixture.componentInstance;

    expect(app.vistaParque()).toBe('TARJETAS');
    app.vistaParque.set('LISTA');
    expect(app.vistaParque()).toBe('LISTA');
  });

  it('filters workstation cards by user, component brand, and serial number', () => {
    const fixture = createApp();
    const app = fixture.componentInstance;
    app.inventoryService.areas.set([{ id: 'area-1', pisoId: 'piso-1', nombre: 'Cajas' }]);
    app.inventoryService.pisos.set([{ id: 'piso-1', nombre: 'Planta Baja', nivel: 0 }]);
    app.inventoryService.puestos.set([
      {
        id: 'puesto-1',
        areaId: 'area-1',
        nombrePuesto: 'Puesto 1',
        usuarioAsignado: 'María Pérez',
        codigoSeguimiento: 'PUESTO-TEST-1',
        componentes: [
          {
            id: 'componente-1',
            tipo: 'MONITOR',
            marca: 'Samsung',
            especificacion: '24 pulgadas',
            numeroSerie: 'SN-ABC-123',
          },
        ],
      },
      {
        id: 'puesto-2',
        areaId: 'area-1',
        nombrePuesto: 'Puesto 2',
        usuarioAsignado: 'Juan',
        codigoSeguimiento: 'PUESTO-TEST-2',
        componentes: [],
      },
    ]);

    app.busquedaParque.set('maria');
    expect(app.puestosFiltrados().map((puesto) => puesto.id)).toEqual(['puesto-1']);

    app.busquedaParque.set('samsung');
    expect(app.puestosFiltrados().map((puesto) => puesto.id)).toEqual(['puesto-1']);

    app.busquedaParque.set('abc-123');
    expect(app.puestosFiltrados().map((puesto) => puesto.id)).toEqual(['puesto-1']);

    app.busquedaParque.set('sin coincidencia');
    expect(app.puestosFiltrados()).toEqual([]);
  });

  it('adds a manually surveyed peripheral to the selected workstation without using stock', async () => {
    const fixture = createApp();
    const app = fixture.componentInstance;
    vi.spyOn(app.inventoryService, 'guardarEnServidor').mockResolvedValue();
    app.inventoryService.puestos.set([
      {
        id: 'puesto-manual',
        areaId: 'area-1',
        nombrePuesto: 'Puesto relevado',
        usuarioAsignado: 'María Pérez',
        codigoSeguimiento: 'PUESTO-TEST-MANUAL',
        componentes: [],
      },
    ]);
    const stockInicial = app.stock();

    app.abrirModalComponente('puesto-manual');
    app.actualizarTipoComponenteManual('MONITOR');
    app.actualizarCampoComponenteManual('marca', 'Dell');
    app.actualizarCampoComponenteManual('modelo', 'P2419H');
    app.actualizarCampoComponenteManual('caracteristicas', '24 pulgadas · SN-123');
    await app.guardarComponenteManual();

    const componente = app.puestos()[0]?.componentes[0];
    expect(componente).toMatchObject({
      tipo: 'MONITOR',
      marca: 'Dell',
      modelo: 'P2419H',
      especificacion: '24 pulgadas · SN-123',
    });
    expect(componente).not.toHaveProperty('codigoSeguimiento');
    expect(app.modalActivo()).toBeNull();
    expect(app.stock()).toEqual(stockInicial);
  });
});

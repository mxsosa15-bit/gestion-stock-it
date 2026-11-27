import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { StockInsumo, Sede } from '../../models/inventory.model';
import { AuthService } from '../../services/auth.service';
import { InventoryService, StockShipmentRequestError } from '../../services/inventory.service';
import { LocationsService } from '../../services/locations.service';
import { StockDispatchComponent } from './stock-dispatch.component';

describe('StockDispatchComponent', () => {
  const operatorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const pendingStorageKey = `gestion-it.pending-stock-shipment:${operatorId}`;
  const destinationId = '11111111-1111-4111-8111-111111111111';
  const stock: StockInsumo[] = [
    {
      id: 'stock-1',
      tipo: 'RAM',
      marca: 'Kingston',
      especificacion: '8 GB',
      cantidadDisponible: 10,
      stockMinimo: 1,
    },
  ];
  const sedes: Sede[] = [
    {
      id: destinationId,
      nombre: 'Delegación Norte',
      tipo: 'DELEGACION',
      departamento: 'Norte',
      localidad: 'Ciudad',
      direccion: 'Calle 1',
      activa: true,
    },
  ];
  let inventoryMock: {
    stock: ReturnType<typeof signal<StockInsumo[]>>;
    enviarStockADelegacion: ReturnType<typeof vi.fn>;
  };
  let fixture: ReturnType<typeof TestBed.createComponent<StockDispatchComponent>>;
  let component: StockDispatchComponent;
  let lockHeld = false;
  let originalLocks: PropertyDescriptor | undefined;

  beforeEach(() => {
    localStorage.removeItem(pendingStorageKey);
    originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
    lockHeld = false;
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: async (
          _name: string,
          _options: unknown,
          callback: (lock: object | null) => Promise<boolean>,
        ) => {
          if (lockHeld) return callback(null);
          lockHeld = true;
          try {
            return await callback({});
          } finally {
            lockHeld = false;
          }
        },
      },
    });
    inventoryMock = {
      stock: signal(stock),
      enviarStockADelegacion: vi.fn(),
    };
    TestBed.configureTestingModule({
      imports: [StockDispatchComponent],
      providers: [
        { provide: InventoryService, useValue: inventoryMock },
        { provide: LocationsService, useValue: { sedes: signal(sedes), cargar: vi.fn() } },
        { provide: AuthService, useValue: { user: signal({ id: operatorId }) } },
      ],
    });
    fixture = TestBed.createComponent(StockDispatchComponent);
    component = fixture.componentInstance;
    component.insumoId.set('stock-1');
    component.destinoSedeId.set(destinationId);
    component.cantidad.set(2);
    component.motivo.set('Reposición mensual');
    fixture.detectChanges();
  });

  afterEach(() => {
    localStorage.removeItem(pendingStorageKey);
    if (originalLocks) {
      Object.defineProperty(navigator, 'locks', originalLocks);
    } else {
      Reflect.deleteProperty(navigator, 'locks');
    }
    TestBed.resetTestingModule();
  });

  it('does not send a request when the operator cancels confirmation', async () => {
    await component.enviar();
    expect(component.confirmacion()).toMatchObject({
      producto: 'RAM · Kingston · 8 GB',
      cantidad: 2,
      destino: 'Delegación Norte',
      motivo: 'Reposición mensual',
    });

    component.cancelarConfirmacion();
    expect(inventoryMock.enviarStockADelegacion).not.toHaveBeenCalled();
    expect(component.pendiente()).toBeNull();
    expect(localStorage.getItem(pendingStorageKey)).toBeNull();
  });

  it('fails closed when cross-tab locking is unavailable', async () => {
    Reflect.deleteProperty(navigator, 'locks');

    await component.enviar();
    await component.confirmarEnvio();

    expect(inventoryMock.enviarStockADelegacion).not.toHaveBeenCalled();
    expect(localStorage.getItem(pendingStorageKey)).toBeNull();
    expect(component.error()).toContain('no permite coordinar envíos entre pestañas');
  });

  it('retries an uncertain shipment with the same key and payload', async () => {
    inventoryMock.enviarStockADelegacion
      .mockRejectedValueOnce(new StockShipmentRequestError('Network unavailable', 0, null, true))
      .mockResolvedValueOnce({ alreadyProcessed: true });

    await component.enviar();
    await component.confirmarEnvio();
    await fixture.whenStable();

    const stored = JSON.parse(localStorage.getItem(pendingStorageKey) ?? 'null') as {
      idempotencyKey: string;
      insumoId: string;
      destinoSedeId: string;
      cantidad: number;
      motivo: string;
    };
    expect(component.estado()).toBe('pending');
    expect(stored.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    fixture.destroy();
    fixture = TestBed.createComponent(StockDispatchComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    expect(component.estado()).toBe('pending');
    expect(component.pendiente()?.idempotencyKey).toBe(stored.idempotencyKey);

    await component.reintentarEnvio();
    await fixture.whenStable();

    expect(inventoryMock.enviarStockADelegacion).toHaveBeenCalledTimes(2);
    expect(inventoryMock.enviarStockADelegacion.mock.calls[0]).toEqual(
      inventoryMock.enviarStockADelegacion.mock.calls[1],
    );
    expect(inventoryMock.enviarStockADelegacion.mock.calls[0]).toEqual([
      'stock-1',
      destinationId,
      2,
      'Reposición mensual',
      stored.idempotencyKey,
      operatorId,
    ]);
    expect(component.estado()).toBe('already-processed');
    expect(localStorage.getItem(pendingStorageKey)).toBeNull();
  });

  it('keeps the operation locked when the server reports an idempotency conflict', async () => {
    inventoryMock.enviarStockADelegacion.mockRejectedValueOnce(
      new StockShipmentRequestError(
        'The key is already associated with another request.',
        409,
        'IDEMPOTENCY_KEY_REUSED',
        false,
      ),
    );

    await component.enviar();
    await component.confirmarEnvio();
    await fixture.whenStable();

    expect(component.estado()).toBe('conflict');
    expect(component.pendiente()).not.toBeNull();
    await component.reintentarEnvio();
    await fixture.whenStable();
    expect(inventoryMock.enviarStockADelegacion).toHaveBeenCalledTimes(1);
    await component.enviar();
    expect(inventoryMock.enviarStockADelegacion).toHaveBeenCalledTimes(1);
  });

  it('clears a pending operation only after a definitive server rejection', async () => {
    inventoryMock.enviarStockADelegacion.mockRejectedValueOnce(
      new StockShipmentRequestError('Insufficient stock.', 400, 'SHIPMENT_REJECTED', false),
    );

    await component.enviar();
    await component.confirmarEnvio();

    expect(component.estado()).toBe('idle');
    expect(component.pendiente()).toBeNull();
    expect(localStorage.getItem(pendingStorageKey)).toBeNull();
    expect(component.error()).toBe('Insufficient stock.');
  });

  it('does not replace another tab’s pending operation for the same operator', async () => {
    let rejectFirst!: (error: unknown) => void;
    const firstResponse = new Promise<{ alreadyProcessed: boolean }>((_resolve, reject) => {
      rejectFirst = reject;
    });
    inventoryMock.enviarStockADelegacion
      .mockReturnValueOnce(firstResponse)
      .mockResolvedValueOnce({ alreadyProcessed: true });

    const secondFixture = TestBed.createComponent(StockDispatchComponent);
    const secondComponent = secondFixture.componentInstance;
    secondComponent.insumoId.set('stock-1');
    secondComponent.destinoSedeId.set(destinationId);
    secondComponent.cantidad.set(5);
    secondComponent.motivo.set('Otro envío');
    secondFixture.detectChanges();

    await component.enviar();
    const firstAttempt = component.confirmarEnvio();
    await vi.waitFor(() => expect(inventoryMock.enviarStockADelegacion).toHaveBeenCalledTimes(1));
    const firstOperation = JSON.parse(localStorage.getItem(pendingStorageKey) ?? 'null') as {
      idempotencyKey: string;
      cantidad: number;
      motivo: string;
    };

    await secondComponent.enviar();
    await secondComponent.confirmarEnvio();

    expect(secondComponent.estado()).toBe('pending');
    expect(secondComponent.error()).toContain('Otra pestaña');
    expect(secondComponent.pendiente()).toMatchObject({
      idempotencyKey: firstOperation.idempotencyKey,
      cantidad: 2,
      motivo: 'Reposición mensual',
    });
    expect(inventoryMock.enviarStockADelegacion).toHaveBeenCalledTimes(1);

    rejectFirst(new StockShipmentRequestError('Network unavailable', 0, null, true));
    await firstAttempt;
    await secondComponent.reintentarEnvio();

    expect(inventoryMock.enviarStockADelegacion).toHaveBeenCalledTimes(2);
    expect(inventoryMock.enviarStockADelegacion.mock.calls[0]).toEqual(
      inventoryMock.enviarStockADelegacion.mock.calls[1],
    );
    expect(firstOperation.cantidad).toBe(2);
    expect(firstOperation.motivo).toBe('Reposición mensual');
    expect(localStorage.getItem(pendingStorageKey)).toBeNull();
    secondFixture.destroy();
  });
});

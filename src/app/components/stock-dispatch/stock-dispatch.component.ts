import { CommonModule, isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  HostListener,
  inject,
  OnInit,
  PLATFORM_ID,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { v4 as uuidv4 } from 'uuid';
import { DEFAULT_SEDE_ID } from '../../../shared/locations';
import type { StockInsumo } from '../../models/inventory.model';
import { AuthService } from '../../services/auth.service';
import { InventoryService, StockShipmentRequestError } from '../../services/inventory.service';
import { LocationsService } from '../../services/locations.service';

interface PendingStockShipment {
  actorId: string;
  idempotencyKey: string;
  insumoId: string;
  destinoSedeId: string;
  cantidad: number;
  motivo: string;
  producto: string;
  destino: string;
}

type StockShipmentConfirmation = Omit<PendingStockShipment, 'actorId' | 'idempotencyKey'>;
type PersistedShipment =
  { kind: 'empty' } | { kind: 'invalid' } | { kind: 'valid'; operation: PendingStockShipment };

@Component({
  selector: 'app-stock-dispatch',
  imports: [CommonModule, FormsModule],
  templateUrl: './stock-dispatch.component.html',
  styleUrl: './stock-dispatch.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StockDispatchComponent implements OnInit {
  readonly inventory = inject(InventoryService);
  readonly locations = inject(LocationsService);
  private readonly auth = inject(AuthService);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly storagePrefix = 'gestion-it.pending-stock-shipment';
  readonly insumoId = signal('');
  readonly destinoSedeId = signal('');
  readonly cantidad = signal(1);
  readonly motivo = signal('');
  readonly enviando = signal(false);
  readonly reservando = signal(false);
  readonly error = signal('');
  readonly aviso = signal('');
  readonly estado = signal<
    'idle' | 'confirming' | 'sending' | 'pending' | 'confirmed' | 'already-processed' | 'conflict'
  >('idle');
  readonly confirmacion = signal<StockShipmentConfirmation | null>(null);
  readonly pendiente = signal<PendingStockShipment | null>(null);

  readonly delegaciones = computed(() =>
    this.locations.sedes().filter((sede) => sede.tipo === 'DELEGACION' && sede.activa),
  );
  readonly stockCentral = computed(() =>
    this.inventory
      .stock()
      .filter(
        (insumo) =>
          (insumo.sedeId ?? DEFAULT_SEDE_ID) === DEFAULT_SEDE_ID && insumo.cantidadDisponible > 0,
      )
      .sort((left, right) =>
        `${left.tipo} ${left.marca} ${left.especificacion}`.localeCompare(
          `${right.tipo} ${right.marca} ${right.especificacion}`,
          'es',
        ),
      ),
  );
  readonly insumoSeleccionado = computed(
    () => this.stockCentral().find((insumo) => insumo.id === this.insumoId()) ?? null,
  );

  ngOnInit(): void {
    this.restaurarEnvioPendiente();
    if (this.locations.sedes().length === 0) {
      void this.locations.cargar().catch((error: unknown) => {
        this.error.set(
          error instanceof Error ? error.message : 'No se pudieron cargar las delegaciones.',
        );
      });
    }
  }

  etiquetaInsumo(insumo: StockInsumo): string {
    return `${insumo.tipo} · ${insumo.marca} · ${insumo.especificacion} (${insumo.cantidadDisponible} disponibles)`;
  }

  async enviar(): Promise<void> {
    if (
      this.pendiente() ||
      this.enviando() ||
      this.reservando() ||
      this.estado() === 'conflict'
    ) return;
    this.estado.set('idle');
    const insumo = this.insumoSeleccionado();
    const destino = this.destinoSedeId();
    const cantidad = this.cantidad();
    const motivo = this.motivo().trim();
    this.error.set('');
    this.aviso.set('');

    if (!insumo || !destino || !Number.isSafeInteger(cantidad) || cantidad <= 0) {
      this.error.set('Seleccioná un producto, una delegación y una cantidad válida.');
      return;
    }
    if (cantidad > insumo.cantidadDisponible) {
      this.error.set('La cantidad supera las existencias de Casa Central.');
      return;
    }
    if (!motivo || motivo.length > 500) {
      this.error.set('Indicá el motivo del envío (hasta 500 caracteres).');
      return;
    }

    this.confirmacion.set({
      insumoId: insumo.id,
      destinoSedeId: destino,
      cantidad,
      motivo,
      producto: `${insumo.tipo} · ${insumo.marca} · ${insumo.especificacion}`,
      destino: this.delegaciones().find((sede) => sede.id === destino)?.nombre ?? 'la delegación',
    });
    this.estado.set('confirming');
  }

  cancelarConfirmacion(): void {
    if (this.enviando() || this.reservando()) return;
    this.confirmacion.set(null);
    this.estado.set('idle');
  }

  async confirmarEnvio(): Promise<void> {
    const confirmation = this.confirmacion();
    if (
      !confirmation ||
      this.enviando() ||
      this.reservando() ||
      this.pendiente() ||
      this.estado() === 'conflict'
    )
      return;
    const actorId = this.auth.user()?.id;
    if (!actorId) {
      this.error.set('No se pudo identificar al operador autenticado; no se envió el stock.');
      return;
    }

    this.reservando.set(true);
    try {
      const reservation = await this.withShipmentLock(actorId, () => {
        const existing = this.leerEnvioPersistido(actorId);
        if (existing.kind !== 'empty') {
          this.mostrarEnvioPersistido(existing);
          return null;
        }

        const operation: PendingStockShipment = {
          ...confirmation,
          actorId,
          idempotencyKey: uuidv4(),
        };
        this.guardarEnvioPendiente(operation);
        this.pendiente.set(operation);
        this.confirmacion.set(null);
        return operation;
      });
      if (!reservation.acquired) {
        this.mostrarPendienteCompartido(actorId);
      } else if (reservation.value) {
        await this.ejecutarEnvio(reservation.value);
      }
    } catch (error: unknown) {
      this.error.set(
        error instanceof Error
          ? error.message
          : 'No se pudo coordinar el envío entre pestañas; no se envió el stock.',
      );
    } finally {
      this.reservando.set(false);
    }
  }

  async reintentarEnvio(): Promise<void> {
    if (
      !this.pendiente() ||
      this.enviando() ||
      this.reservando() ||
      this.estado() === 'conflict'
    ) return;
    const actorId = this.auth.user()?.id;
    if (!actorId) {
      this.error.set('Iniciá sesión con el operador que confirmó este envío para reintentarlo.');
      return;
    }

    this.reservando.set(true);
    try {
      let resolvedInAnotherTab = false;
      const retry = await this.withShipmentLock(actorId, () => {
        const persisted = this.leerEnvioPersistido(actorId);
        if (persisted.kind === 'empty') {
          this.pendiente.set(null);
          this.estado.set('idle');
          this.aviso.set('Otra pestaña resolvió la operación. Se actualizará el inventario.');
          resolvedInAnotherTab = true;
          return null;
        }
        if (persisted.kind === 'invalid') {
          this.estado.set('conflict');
          this.error.set(
            'No se pudo validar la operación compartida. Verificá el movimiento antes de iniciar otro envío.',
          );
          return null;
        }

        this.pendiente.set(persisted.operation);
        return persisted.operation;
      });
      if (!retry.acquired) {
        this.mostrarPendienteCompartido(actorId);
      } else if (retry.value) {
        await this.ejecutarEnvio(retry.value);
      } else if (resolvedInAnotherTab) {
        await this.inventory.cargarDesdeServidor();
      }
    } catch (error: unknown) {
      this.error.set(
        error instanceof Error ? error.message : 'No se pudo verificar el envío pendiente.',
      );
    } finally {
      this.reservando.set(false);
    }
  }

  private async ejecutarEnvio(operation: PendingStockShipment): Promise<void> {
    if (this.auth.user()?.id !== operation.actorId) {
      this.estado.set('conflict');
      this.error.set(
        'La sesión corresponde a otro operador. Volvé a ingresar con el operador que confirmó el envío para verificarlo.',
      );
      return;
    }
    this.enviando.set(true);
    this.error.set('');
    this.aviso.set('');
    this.estado.set('sending');
    try {
      const result = await this.inventory.enviarStockADelegacion(
        operation.insumoId,
        operation.destinoSedeId,
        operation.cantidad,
        operation.motivo,
        operation.idempotencyKey,
        operation.actorId,
      );
      const cleared = await this.eliminarEnvioPendiente(operation);
      if (!cleared) {
        this.estado.set('conflict');
        this.error.set(
          'El envío respondió correctamente, pero el pendiente compartido cambió. No inicies otro envío hasta verificarlo.',
        );
        return;
      }
      this.pendiente.set(null);
      this.estado.set(result.alreadyProcessed ? 'already-processed' : 'confirmed');
      this.aviso.set(
        result.alreadyProcessed
          ? `El envío ya estaba procesado. Se actualizó el inventario de ${operation.destino}.`
          : `Se enviaron ${operation.cantidad} unidades a ${operation.destino}.`,
      );
      this.insumoId.set('');
      this.cantidad.set(1);
      this.motivo.set('');
    } catch (error: unknown) {
      if (error instanceof StockShipmentRequestError && error.code === 'OPERATOR_SESSION_CHANGED') {
        this.estado.set('conflict');
        this.error.set(
          'La sesión del operador cambió durante el envío. El pendiente se conservó; ingresá con el operador original para verificarlo.',
        );
      } else if (
        error instanceof StockShipmentRequestError &&
        error.code === 'IDEMPOTENCY_KEY_REUSED'
      ) {
        this.estado.set('conflict');
        this.error.set(
          'Conflicto de idempotencia: esta clave está asociada a otro contenido. No modifiques ni vuelvas a enviar esta operación; verificá el movimiento con administración.',
        );
      } else if (error instanceof StockShipmentRequestError && error.outcomeUnknown) {
        this.estado.set('pending');
        this.error.set(
          'No se pudo confirmar la respuesta. El envío puede haberse procesado; reintentá aquí para verificarlo con la misma operación, sin duplicar stock.',
        );
      } else {
        const cleared = await this.eliminarEnvioPendiente(operation);
        this.pendiente.set(cleared ? null : operation);
        this.estado.set(cleared ? 'idle' : 'conflict');
        this.error.set(
          cleared
            ? error instanceof Error
              ? error.message
              : 'No se pudo completar el envío de stock.'
            : 'El servidor rechazó el envío y no se pudo limpiar el pendiente local. No inicies otro envío hasta resolverlo.',
        );
      }
    } finally {
      this.enviando.set(false);
    }
  }

  private restaurarEnvioPendiente(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    const actorId = this.auth.user()?.id;
    if (!actorId) return;
    const persisted = this.leerEnvioPersistido(actorId);
    if (persisted.kind === 'valid') {
      this.adoptarEnvioPersistido(
        persisted.operation,
        'Se recuperó un envío cuyo resultado no se había confirmado. Reintentá para verificarlo con la misma clave.',
      );
    } else if (persisted.kind === 'invalid') {
      this.estado.set('conflict');
      this.error.set(
        'No se pudo validar la operación guardada. Verificá el inventario antes de iniciar otro envío.',
      );
    }
  }

  private esEnvioPendiente(value: unknown, actorId: string): value is PendingStockShipment {
    if (!value || typeof value !== 'object') return false;
    const shipment = value as Record<string, unknown>;
    return (
      shipment['actorId'] === actorId &&
      typeof shipment['idempotencyKey'] === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        shipment['idempotencyKey'],
      ) &&
      typeof shipment['insumoId'] === 'string' &&
      shipment['insumoId'].length > 0 &&
      shipment['insumoId'].length <= 200 &&
      typeof shipment['destinoSedeId'] === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        shipment['destinoSedeId'],
      ) &&
      typeof shipment['cantidad'] === 'number' &&
      Number.isSafeInteger(shipment['cantidad']) &&
      shipment['cantidad'] > 0 &&
      shipment['cantidad'] <= 1_000_000 &&
      typeof shipment['motivo'] === 'string' &&
      shipment['motivo'].trim().length > 0 &&
      shipment['motivo'].length <= 500 &&
      typeof shipment['producto'] === 'string' &&
      typeof shipment['destino'] === 'string'
    );
  }

  private guardarEnvioPendiente(operation: PendingStockShipment): void {
    const storageKey = this.claveAlmacenamiento(operation.actorId);
    if (!isPlatformBrowser(this.platformId) || !storageKey) {
      throw new Error('No se pudo identificar la sesión del operador en el navegador.');
    }
    localStorage.setItem(storageKey, JSON.stringify(operation));
  }

  private async eliminarEnvioPendiente(operation: PendingStockShipment): Promise<boolean> {
    try {
      const result = await this.withShipmentLock(
        operation.actorId,
        () => {
          const current = this.leerEnvioPersistido(operation.actorId);
          if (current.kind === 'empty') return true;
          if (current.kind !== 'valid' || !this.mismaOperacion(current.operation, operation)) {
            return false;
          }
          const storageKey = this.claveAlmacenamiento(operation.actorId);
          if (!storageKey) return false;
          localStorage.removeItem(storageKey);
          return true;
        },
        false,
      );
      return result.acquired && result.value === true;
    } catch {
      return false;
    }
  }

  private leerEnvioPersistido(actorId: string): PersistedShipment {
    const storageKey = this.claveAlmacenamiento(actorId);
    if (!isPlatformBrowser(this.platformId) || !storageKey) return { kind: 'invalid' };
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored === null) return { kind: 'empty' };
      const value: unknown = JSON.parse(stored);
      return this.esEnvioPendiente(value, actorId)
        ? { kind: 'valid', operation: value }
        : { kind: 'invalid' };
    } catch {
      return { kind: 'invalid' };
    }
  }

  private mostrarEnvioPersistido(persisted: PersistedShipment): void {
    if (persisted.kind === 'valid') {
      this.adoptarEnvioPersistido(
        persisted.operation,
        'Otra pestaña tiene un envío pendiente. Se cargó la misma operación; verificá o reintentá antes de crear otra.',
      );
      return;
    }
    this.confirmacion.set(null);
    this.estado.set('conflict');
    this.error.set(
      'Hay un registro de envío compartido que no se pudo validar. No inicies otro envío hasta verificarlo.',
    );
  }

  private mostrarPendienteCompartido(actorId: string): void {
    const persisted = this.leerEnvioPersistido(actorId);
    if (persisted.kind === 'valid' || persisted.kind === 'invalid') {
      this.mostrarEnvioPersistido(persisted);
      return;
    }
    if (this.pendiente()) {
      this.estado.set('conflict');
      this.error.set(
        'El envío pendiente ya no está en el almacenamiento compartido. Verificá el inventario antes de continuar.',
      );
    } else {
      this.error.set(
        'Otra pestaña está procesando un envío. Esperá y verificá la operación pendiente.',
      );
    }
  }

  private adoptarEnvioPersistido(operation: PendingStockShipment, message: string): void {
    this.confirmacion.set(null);
    this.pendiente.set(operation);
    this.estado.set('pending');
    this.error.set(message);
  }

  private mismaOperacion(left: PendingStockShipment, right: PendingStockShipment): boolean {
    return (
      left.actorId === right.actorId &&
      left.idempotencyKey === right.idempotencyKey &&
      left.insumoId === right.insumoId &&
      left.destinoSedeId === right.destinoSedeId &&
      left.cantidad === right.cantidad &&
      left.motivo === right.motivo
    );
  }

  private withShipmentLock<T>(
    actorId: string,
    action: () => T,
    ifAvailable = true,
  ): Promise<{ acquired: boolean; value: T | null }> {
    if (!isPlatformBrowser(this.platformId) || !navigator.locks) {
      return Promise.reject(
        new Error(
          'Este navegador no permite coordinar envíos entre pestañas. Actualizá el navegador y usá una conexión segura.',
        ),
      );
    }
    const options: LockOptions = ifAvailable
      ? { mode: 'exclusive', ifAvailable: true }
      : { mode: 'exclusive' };
    return navigator.locks.request<{ acquired: boolean; value: T | null }>(
      `${this.storagePrefix}:${actorId}`,
      options,
      (lock) => {
        if (!lock) return { acquired: false, value: null };
        return { acquired: true, value: action() };
      },
    );
  }

  @HostListener('window:storage', ['$event'])
  onStorageChanged(event: StorageEvent): void {
    const actorId = this.auth.user()?.id;
    const storageKey = this.claveAlmacenamiento(actorId);
    if (!actorId || !storageKey || event.key !== storageKey) return;

    const persisted = this.leerEnvioPersistido(actorId);
    if (persisted.kind === 'valid') {
      this.adoptarEnvioPersistido(
        persisted.operation,
        'Otra pestaña tiene esta operación pendiente. No se puede iniciar otro envío hasta resolverla.',
      );
      return;
    }
    if (persisted.kind === 'invalid') {
      this.confirmacion.set(null);
      this.estado.set('conflict');
      this.error.set('El estado compartido del envío no es válido. Verificá el movimiento.');
      return;
    }

    let previous: unknown = null;
    if (event.oldValue) {
      try {
        previous = JSON.parse(event.oldValue) as unknown;
      } catch {
        this.estado.set('conflict');
        this.error.set('El registro anterior del envío no se pudo validar.');
        return;
      }
    }
    const current = this.pendiente();
    if (
      current &&
      this.esEnvioPendiente(previous, actorId) &&
      this.mismaOperacion(current, previous)
    ) {
      this.pendiente.set(null);
      this.estado.set('idle');
      this.error.set('');
      this.aviso.set('Otra pestaña resolvió el envío. Actualizando el inventario.');
      void this.inventory.cargarDesdeServidor().catch((error: unknown) => {
        this.error.set(
          error instanceof Error ? error.message : 'No se pudo actualizar el inventario.',
        );
      });
    }
  }

  private claveAlmacenamiento(actorId: string | null | undefined): string | null {
    return actorId ? `${this.storagePrefix}:${actorId}` : null;
  }
}

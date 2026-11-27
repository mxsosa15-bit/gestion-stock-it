import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import {
  Area,
  ComponentePuesto,
  ComponenteRetirado,
  EquipoRed,
  EstadoComponenteRetirado,
  HistorialMovimiento,
  Piso,
  PersonaInventario,
  PuestoTrabajo,
  SolicitudTransferenciaInventario,
  StockInsumo,
  TipoEquipoRed,
  TipoMovimiento,
  TipoPeriferico,
  TransferenciaInventario,
} from '../models/inventory.model';
import { DEFAULT_SEDE_ID } from '../../shared/locations';
import type { PagedResult } from '../models/paged-result';

export interface InventoryTransferFilters {
  search: string;
  site: string;
  area: string;
  operator: string;
  from: string;
  to: string;
  type: string;
  sort: 'newest' | 'oldest';
  page: number;
  pageSize: number;
}

export interface InventoryData {
  pisos: Piso[];
  areas: Area[];
  personas: PersonaInventario[];
  stock: StockInsumo[];
  puestos: PuestoTrabajo[];
  equiposRed: EquipoRed[];
  componentesRetirados: ComponenteRetirado[];
  historial: HistorialMovimiento[];
}

const absentValue = Symbol('absent');
type MaybeValue = unknown | typeof absentValue;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T;
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneValue(item)]),
    ) as T;
  }
  return value;
}

function valuesEqual(left: MaybeValue, right: MaybeValue): boolean {
  if (left === absentValue || right === absentValue) return left === right;
  if (Object.is(left, right)) return true;
  if (left instanceof Date || right instanceof Date) {
    const leftTime =
      left instanceof Date
        ? left.getTime()
        : typeof left === 'string'
          ? Date.parse(left)
          : Number.NaN;
    const rightTime =
      right instanceof Date
        ? right.getTime()
        : typeof right === 'string'
          ? Date.parse(right)
          : Number.NaN;
    return Number.isFinite(leftTime) && leftTime === rightTime;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => valuesEqual(value, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key) => Object.hasOwn(right, key) && valuesEqual(left[key], right[key]),
      )
    );
  }
  return false;
}

function isIdArray(
  base: MaybeValue,
  server: MaybeValue,
  local: MaybeValue,
): base is Record<string, unknown>[] {
  return [base, server, local].every(
    (value) =>
      Array.isArray(value) &&
      value.every((item) => isRecord(item) && typeof item['id'] === 'string'),
  );
}

function mergeConcurrentValues(
  base: MaybeValue,
  server: MaybeValue,
  local: MaybeValue,
): MaybeValue {
  if (valuesEqual(local, base)) return cloneValue(server);
  if (valuesEqual(server, base) || valuesEqual(server, local)) return cloneValue(local);
  if (local === absentValue) return absentValue;
  if (server === absentValue) return cloneValue(local);

  if (isRecord(base) && isRecord(server) && isRecord(local)) {
    const merged: Record<string, unknown> = {};
    const keys = new Set([...Object.keys(base), ...Object.keys(server), ...Object.keys(local)]);
    for (const key of keys) {
      const value = mergeConcurrentValues(
        Object.hasOwn(base, key) ? base[key] : absentValue,
        Object.hasOwn(server, key) ? server[key] : absentValue,
        Object.hasOwn(local, key) ? local[key] : absentValue,
      );
      if (value !== absentValue) merged[key] = value;
    }
    return merged;
  }

  if (isIdArray(base, server, local)) {
    const records = (value: MaybeValue): Map<string, Record<string, unknown>> =>
      new Map(
        (value as Record<string, unknown>[]).map(
          (record) => [record['id'] as string, record] as const,
        ),
      );
    const baseRecords = records(base);
    const serverRecords = records(server);
    const localRecords = records(local);
    const ids = [...new Set([...localRecords.keys(), ...serverRecords.keys()])];
    return ids.flatMap((id) => {
      const value = mergeConcurrentValues(
        baseRecords.get(id) ?? absentValue,
        serverRecords.get(id) ?? absentValue,
        localRecords.get(id) ?? absentValue,
      );
      return value === absentValue ? [] : [value];
    });
  }

  return cloneValue(local);
}

export type ComponentEdit = Omit<ComponentePuesto, 'id'>;

export interface InventoryBackup {
  format: 'gestion-it-backup';
  version: 1;
  createdAt: string;
  inventory: InventoryData;
}

interface InventoryResponse {
  revision: string;
  payload: InventoryData;
}

interface TransferResponse extends InventoryResponse {
  transferenciaId: string;
}

interface StockShipmentResponse extends InventoryResponse {
  idempotencyKey: string;
  movementId: string;
  alreadyProcessed: boolean;
}

export class StockShipmentRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly outcomeUnknown: boolean,
  ) {
    super(message);
    this.name = 'StockShipmentRequestError';
  }
}

@Injectable({
  providedIn: 'root',
})
export class InventoryService {
  private readonly http = inject(HttpClient);
  private idSequence = 0;
  private revision = 0;
  private persistedSnapshot: InventoryData | null = null;
  private writeQueue: Promise<void> | null = null;

  readonly pisos = signal<Piso[]>([]);
  readonly areas = signal<Area[]>([]);
  readonly personas = signal<PersonaInventario[]>([]);
  readonly stock = signal<StockInsumo[]>([]);
  readonly puestos = signal<PuestoTrabajo[]>([]);
  readonly equiposRed = signal<EquipoRed[]>([]);
  readonly componentesRetirados = signal<ComponenteRetirado[]>([]);
  readonly historial = signal<HistorialMovimiento[]>([]);
  readonly cargando = signal(false);
  readonly errorCarga = signal('');
  readonly errorServidor = signal('');
  readonly conflictoInventario = signal<
    { revision: string; payload: InventoryData } | null
  >(null);

  async cargarDesdeServidor(): Promise<void> {
    if (this.conflictoInventario()) {
      const message = this.mensajeConflictoRevision();
      this.errorServidor.set(message);
      throw new Error(message);
    }
    this.cargando.set(true);
    this.errorCarga.set('');
    this.errorServidor.set('');
    try {
      const response = await firstValueFrom(this.http.get<InventoryResponse>('/api/inventory'));
      this.revision = Number(response.revision);
      this.aplicarInventario(response.payload);
      this.persistedSnapshot = cloneValue(this.obtenerInventario());
      this.conflictoInventario.set(null);
    } catch (error: unknown) {
      const message = this.obtenerMensajeError(
        error,
        'No se pudo cargar el inventario del servidor.',
      );
      this.errorCarga.set(message);
      throw new Error(message);
    } finally {
      this.cargando.set(false);
    }
  }

  guardarEnServidor(): Promise<void> {
    return this.serializarEscritura(async () => {
      const payload = cloneValue(this.obtenerInventario());
      try {
        const response = await firstValueFrom(
          this.http.put<InventoryResponse>('/api/inventory', {
            revision: this.revision,
            payload,
          }),
        );
        this.aceptarRespuestaDelServidor(response, payload);
        this.errorServidor.set('');
      } catch (error: unknown) {
        const conflicto = this.registrarConflictoRevision(error);
        const message = conflicto
          ? this.mensajeConflictoRevision()
          : this.obtenerMensajeError(
              error,
              'No se pudieron guardar los cambios en el servidor. Tus cambios locales se conservaron.',
            );
        this.errorServidor.set(message);
        throw new Error(message);
      }
    });
  }

  async enviarStockADelegacion(
    insumoId: string,
    destinoSedeId: string,
    cantidad: number,
    motivo: string,
    idempotencyKey: string,
    expectedActorId: string,
  ): Promise<{ alreadyProcessed: boolean }> {
    return this.serializarEscritura(async () => {
      const base = cloneValue(this.persistedSnapshot ?? this.obtenerInventario());
      try {
        const response = await firstValueFrom(
          this.http.post<StockShipmentResponse>('/api/inventory/stock-transfers', {
            insumoId,
            destinoSedeId,
            cantidad,
            motivo,
            idempotencyKey,
            expectedActorId,
          }),
        );
        this.aceptarRespuestaDelServidor(response, base);
        this.errorServidor.set('');
        return { alreadyProcessed: response.alreadyProcessed };
      } catch (error: unknown) {
        const message = this.obtenerMensajeError(
          error,
          'No se pudo enviar el stock a la delegación. Los cambios locales se conservaron.',
        );
        this.errorServidor.set(message);
        if (error instanceof HttpErrorResponse) {
          const code = error.error?.code;
          const errorCode = typeof code === 'string' ? code : null;
          throw new StockShipmentRequestError(
            message,
            error.status,
            errorCode,
            !(error.status === 400 && errorCode === 'SHIPMENT_REJECTED'),
          );
        }
        throw new StockShipmentRequestError(message, 0, null, true);
      }
    });
  }

  async editarComponenteAdministrativamente(
    puestoId: string,
    componenteId: string,
    changes: ComponentEdit,
    reason: string,
  ): Promise<void> {
    return this.serializarEscritura(async () => {
      const base = cloneValue(this.persistedSnapshot ?? this.obtenerInventario());
      try {
        const response = await firstValueFrom(
          this.http.patch<InventoryResponse>(
            `/api/inventory/puestos/${encodeURIComponent(puestoId)}/componentes/${encodeURIComponent(componenteId)}`,
            { revision: this.revision, changes, reason },
          ),
        );
        this.aceptarRespuestaDelServidor(response, base);
        this.errorServidor.set('');
      } catch (error: unknown) {
        const conflicto = this.registrarConflictoRevision(error);
        const message = conflicto
          ? this.mensajeConflictoRevision()
          : this.obtenerMensajeError(
              error,
              'No se pudo actualizar el componente en el servidor. Los cambios locales se conservaron.',
            );
        this.errorServidor.set(message);
        throw new Error(message);
      }
    });
  }

  exportarRespaldo(): InventoryBackup {
    return {
      format: 'gestion-it-backup',
      version: 1,
      createdAt: new Date().toISOString(),
      inventory: this.obtenerInventario(),
    };
  }

  async importarRespaldo(value: unknown): Promise<void> {
    if (!this.esRespaldo(value)) {
      throw new Error('El archivo no es un respaldo válido de Gestión IT.');
    }
    return this.serializarEscritura(async () => {
      const base = cloneValue(this.obtenerInventario());
      try {
        const response = await firstValueFrom(
          this.http.post<InventoryResponse>('/api/inventory/import', {
            payload: value.inventory,
          }),
        );
        this.aceptarRespuestaDelServidor(response, base);
        this.errorServidor.set('');
      } catch (error: unknown) {
        const conflicto = this.registrarConflictoRevision(error);
        const message = conflicto
          ? this.mensajeConflictoRevision()
          : this.obtenerMensajeError(
              error,
              'No se pudo importar el respaldo en el servidor. Los cambios locales se conservaron.',
            );
        this.errorServidor.set(message);
        throw new Error(message);
      }
    });
  }

  async resolverConflictoConRespaldo(value: unknown): Promise<void> {
    if (!this.esRespaldo(value)) {
      throw new Error('El archivo no es un respaldo válido de Gestión IT.');
    }
    const conflicto = this.conflictoInventario();
    if (!conflicto) {
      throw new Error('No hay un conflicto de revisión pendiente para resolver.');
    }

    this.revision = Number(conflicto.revision);
    this.persistedSnapshot = cloneValue(conflicto.payload);
    this.aplicarInventario(cloneValue(value.inventory));
    this.conflictoInventario.set(null);
    this.errorServidor.set('');
    await this.guardarEnServidor();
  }

  private serializarEscritura<T>(operation: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      if (this.conflictoInventario()) {
        const message = this.mensajeConflictoRevision();
        this.errorServidor.set(message);
        throw new Error(message);
      }
      return operation();
    };
    const result = this.writeQueue ? this.writeQueue.then(run) : run();
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.writeQueue = tail;
    void tail.then(() => {
      if (this.writeQueue === tail) this.writeQueue = null;
    });
    return result;
  }

  private aceptarRespuestaDelServidor(
    response: InventoryResponse,
    base: InventoryData,
  ): void {
    const local = this.obtenerInventario();
    const merged = mergeConcurrentValues(base, response.payload, local);
    if (!isRecord(merged) || !this.esInventario(merged)) {
      throw new Error('El servidor devolvió un inventario inválido.');
    }

    this.revision = Number(response.revision);
    this.persistedSnapshot = cloneValue(response.payload);
    this.aplicarInventario(merged);
    this.conflictoInventario.set(null);
  }

  private registrarConflictoRevision(error: unknown): boolean {
    if (!(error instanceof HttpErrorResponse) || error.status !== 409 || !isRecord(error.error)) {
      return false;
    }
    const remote = error.error;
    const revision = remote['revision'];
    const payload = remote['payload'];
    if (
      typeof revision !== 'string' ||
      !Number.isSafeInteger(Number(revision)) ||
      !this.esInventario(payload)
    ) {
      return false;
    }

    this.conflictoInventario.set({
      revision,
      payload: cloneValue(payload),
    });
    return true;
  }

  private mensajeConflictoRevision(): string {
    return 'El inventario cambió en el servidor. Tus cambios locales se conservaron y no se volverán a enviar automáticamente. Compará ambas versiones y resolvé el conflicto antes de continuar.';
  }

  private esRespaldo(value: unknown): value is InventoryBackup {
    return (
      isRecord(value) &&
      value['format'] === 'gestion-it-backup' &&
      value['version'] === 1 &&
      this.esInventario(value['inventory'])
    );
  }

  private esInventario(value: unknown): value is InventoryData {
    if (!value || typeof value !== 'object') return false;
    const inventory = value as Record<string, unknown>;
    return (
      [
        'pisos',
        'areas',
        'stock',
        'puestos',
        'equiposRed',
        'componentesRetirados',
        'historial',
      ].every((key) => Array.isArray(inventory[key])) &&
      (inventory['personas'] === undefined || Array.isArray(inventory['personas']))
    );
  }

  private obtenerInventario(): InventoryData {
    return {
      pisos: this.pisos(),
      areas: this.areas(),
      personas: this.personas(),
      stock: this.stock(),
      puestos: this.puestos(),
      equiposRed: this.equiposRed(),
      componentesRetirados: this.componentesRetirados(),
      historial: this.historial(),
    };
  }

  private aplicarInventario(inventory: InventoryData): void {
    this.pisos.set(inventory.pisos);
    this.areas.set(inventory.areas);
    this.personas.set(
      inventory.personas ??
        inventory.puestos.flatMap((puesto) =>
          puesto.usuarioAsignado.trim()
            ? [
                {
                  id: `persona-${puesto.id}`,
                  nombre: puesto.usuarioAsignado.trim(),
                  areaId: puesto.areaId,
                  puestoId: puesto.id,
                },
              ]
            : [],
        ),
    );
    this.stock.set(inventory.stock);
    this.puestos.set(inventory.puestos);
    this.equiposRed.set(inventory.equiposRed);
    this.componentesRetirados.set(
      inventory.componentesRetirados.map((item) => ({
        ...item,
        fechaRetiro: new Date(item.fechaRetiro),
      })),
    );
    this.historial.set(
      inventory.historial.map((item) => ({ ...item, fecha: new Date(item.fecha) })),
    );
  }

  private obtenerMensajeError(error: unknown, fallback: string): string {
    if (error instanceof HttpErrorResponse) {
      const message = error.error?.error;
      return typeof message === 'string' ? message : fallback;
    }
    return error instanceof Error ? error.message : fallback;
  }

  private generarId(prefijo: string): string {
    return `${prefijo}-${Date.now().toString(36)}-${++this.idSequence}-${uuidv4()}`;
  }

  private sedeDeArea(areaId: string): string {
    const area = this.areas().find((item) => item.id === areaId);
    const piso = area ? this.pisos().find((item) => item.id === area.pisoId) : undefined;
    return piso?.sedeId ?? DEFAULT_SEDE_ID;
  }

  private normalizarComponente(componente: ComponentePuesto): ComponentePuesto {
    return componente;
  }

  private normalizarInsumo(insumo: StockInsumo): StockInsumo {
    return insumo;
  }

  private registrarHistorial(
    tipo: TipoMovimiento,
    detalle: string,
    opciones: {
      insumoId?: string;
      puestoId?: string;
      equipoRedId?: string;
      componenteRetiradoId?: string;
      cantidad?: number;
      sedeId?: string;
    } = {},
  ): void {
    const puesto = opciones.puestoId
      ? this.puestos().find((item) => item.id === opciones.puestoId)
      : undefined;
    const equipoRed = opciones.equipoRedId
      ? this.equiposRed().find((item) => item.id === opciones.equipoRedId)
      : undefined;
    const insumo = opciones.insumoId
      ? this.stock().find((item) => item.id === opciones.insumoId)
      : undefined;
    const sedeId =
      opciones.sedeId ??
      insumo?.sedeId ??
      (puesto ? this.sedeDeArea(puesto.areaId) : undefined) ??
      (equipoRed ? this.sedeDeArea(equipoRed.areaId) : undefined);
    const movimiento: HistorialMovimiento = {
      id: this.generarId('hist'),
      fecha: new Date(),
      tipo,
      cantidad: opciones.cantidad ?? 1,
      detalle,
      ...(sedeId ? { sedeId } : {}),
      ...(opciones.insumoId ? { insumoId: opciones.insumoId } : {}),
      ...(opciones.puestoId ? { puestoId: opciones.puestoId } : {}),
      ...(opciones.equipoRedId ? { equipoRedId: opciones.equipoRedId } : {}),
      ...(opciones.componenteRetiradoId
        ? { componenteRetiradoId: opciones.componenteRetiradoId }
        : {}),
    };
    this.historial.update((registros) => [movimiento, ...registros]);
  }

  crearPiso(nombre: string, nivel: number, sedeId = DEFAULT_SEDE_ID): Piso {
    const nuevoPiso: Piso = { id: this.generarId('piso'), nombre, nivel, sedeId };
    this.pisos.update((pisos) => [...pisos, nuevoPiso]);
    return nuevoPiso;
  }

  editarPiso(pisoId: string, changes: Pick<Piso, 'nombre' | 'nivel'>): void {
    if (!this.pisos().some((item) => item.id === pisoId)) {
      throw new Error('No se encontró el piso que querés editar.');
    }
    const nombre = changes.nombre.trim();
    if (
      !nombre ||
      nombre.length > 120 ||
      !Number.isSafeInteger(changes.nivel) ||
      changes.nivel < 0
    ) {
      throw new Error('Ingresá un nombre de piso y un nivel entero no negativo.');
    }
    this.pisos.update((items) =>
      items.map((item) => (item.id === pisoId ? { ...item, nombre, nivel: changes.nivel } : item)),
    );
  }

  editarArea(areaId: string, nombre: string): void {
    const area = this.areas().find((item) => item.id === areaId);
    if (!area) throw new Error('No se encontró el área que querés editar.');
    const nombreValidado = nombre.trim();
    if (!nombreValidado || nombreValidado.length > 120) {
      throw new Error('Ingresá un nombre de área válido de hasta 120 caracteres.');
    }
    if (
      this.areas().some(
        (item) =>
          item.id !== areaId &&
          item.nombre.toLocaleLowerCase() === nombreValidado.toLocaleLowerCase(),
      )
    ) {
      throw new Error('Ya existe un área con ese nombre.');
    }
    this.areas.update((areas) =>
      areas.map((item) => (item.id === areaId ? { ...item, nombre: nombreValidado } : item)),
    );
  }

  eliminarPiso(pisoId: string): void {
    if (this.areas().some((area) => area.pisoId === pisoId)) {
      throw new Error(
        'No se puede eliminar este piso porque tiene áreas asignadas. Eliminá o reubicá las áreas primero.',
      );
    }
    this.pisos.update((pisos) => pisos.filter((piso) => piso.id !== pisoId));
  }

  crearArea(pisoId: string, nombre: string): Area {
    const nuevaArea: Area = { id: this.generarId('area'), pisoId, nombre };
    this.areas.update((areas) => [...areas, nuevaArea]);
    return nuevaArea;
  }

  eliminarArea(areaId: string): void {
    if (this.personas().some((persona) => persona.areaId === areaId)) {
      throw new Error('No se puede eliminar esta área porque tiene personas asignadas.');
    }
    if (this.puestos().some((puesto) => puesto.areaId === areaId)) {
      throw new Error(
        'No se puede eliminar esta área porque tiene puestos de trabajo registrados.',
      );
    }
    if (this.equiposRed().some((equipo) => equipo.areaId === areaId)) {
      throw new Error('No se puede eliminar esta área porque tiene equipos de red asignados.');
    }
    this.areas.update((areas) => areas.filter((area) => area.id !== areaId));
  }

  crearEquipoRed(
    nuevoEquipo: Omit<EquipoRed, 'id' | 'codigoSeguimiento'> & {
      codigoSeguimiento?: string;
    },
  ): EquipoRed {
    if (!this.areas().some((area) => area.id === nuevoEquipo.areaId)) {
      throw new Error(`No existe el área "${nuevoEquipo.areaId}" para asignar el equipo de red.`);
    }

    const equipo: EquipoRed = {
      ...nuevoEquipo,
      id: this.generarId('red'),
      codigoSeguimiento: nuevoEquipo.codigoSeguimiento ?? '',
    };
    this.equiposRed.update((equipos) => [...equipos, equipo]);
    const sedeId = this.sedeDeArea(equipo.areaId);
    this.registrarHistorial(
      'ALTA_EQUIPO_RED',
      `Se registró un ${equipo.tipo} ${equipo.marca} ${equipo.modelo} en el área ${equipo.areaId}.`,
      { equipoRedId: equipo.id, sedeId },
    );
    return equipo;
  }

  eliminarEquipoRed(equipoRedId: string): void {
    const equipo = this.equiposRed().find((item) => item.id === equipoRedId);
    if (!equipo) {
      return;
    }
    const sedeId = this.sedeDeArea(equipo.areaId);
    this.equiposRed.update((equipos) => equipos.filter((item) => item.id !== equipoRedId));
    this.registrarHistorial(
      'BAJA_EQUIPO_RED',
      `Se eliminó el ${equipo.tipo} ${equipo.marca} ${equipo.modelo} del área ${equipo.areaId}.`,
      { equipoRedId: equipo.id, sedeId },
    );
  }

  editarEquipoRed(
    equipoRedId: string,
    changes: Pick<EquipoRed, 'tipo' | 'marca' | 'modelo'>,
  ): void {
    const equipo = this.equiposRed().find((item) => item.id === equipoRedId);
    if (!equipo) throw new Error('No se encontró el equipo de red que querés editar.');
    const marca = changes.marca.trim();
    const modelo = changes.modelo.trim();
    if (!marca || marca.length > 120 || !modelo || modelo.length > 120) {
      throw new Error('Completá marca y modelo con un máximo de 120 caracteres.');
    }
    this.equiposRed.update((items) =>
      items.map((item) =>
        item.id === equipoRedId ? { ...item, tipo: changes.tipo, marca, modelo } : item,
      ),
    );
  }

  agregarInsumoStock(
    nuevoItem: Omit<StockInsumo, 'id' | 'codigoSeguimiento'>,
    sedeId = nuevoItem.sedeId ?? DEFAULT_SEDE_ID,
  ): void {
    if (!Number.isInteger(nuevoItem.cantidadDisponible) || nuevoItem.cantidadDisponible <= 0) {
      throw new Error('La cantidad a ingresar debe ser un entero mayor que cero.');
    }
    if (!Number.isInteger(nuevoItem.stockMinimo) || nuevoItem.stockMinimo < 0) {
      throw new Error('El stock mínimo debe ser un entero igual o mayor que cero.');
    }

    const existente = this.stock().find(
      (insumo) =>
        insumo.tipo === nuevoItem.tipo &&
        insumo.marca === nuevoItem.marca &&
        insumo.especificacion === nuevoItem.especificacion &&
        (insumo.sedeId ?? DEFAULT_SEDE_ID) === sedeId,
    );

    const idInsumo = existente?.id ?? this.generarId('stk');
    if (existente) {
      this.stock.update((stock) =>
        stock.map((insumo) =>
          insumo.id === existente.id
            ? {
                ...insumo,
                cantidadDisponible: insumo.cantidadDisponible + nuevoItem.cantidadDisponible,
              }
            : insumo,
        ),
      );
    } else {
      const nuevoInsumo = this.normalizarInsumo({ ...nuevoItem, sedeId, id: idInsumo });
      this.stock.update((stock) => [...stock, nuevoInsumo]);
    }

    this.registrarHistorial(
      'INGRESO_STOCK',
      `Ingreso de stock: +${nuevoItem.cantidadDisponible} u. de ${nuevoItem.tipo} (${nuevoItem.marca} - ${nuevoItem.especificacion})`,
      { insumoId: idInsumo, cantidad: nuevoItem.cantidadDisponible, sedeId },
    );
  }

  registrarSaldoInicial(
    nuevoItem: Omit<StockInsumo, 'id' | 'codigoSeguimiento'>,
    sedeId = nuevoItem.sedeId ?? DEFAULT_SEDE_ID,
  ): void {
    if (!Number.isInteger(nuevoItem.cantidadDisponible) || nuevoItem.cantidadDisponible < 0) {
      throw new Error('El saldo inicial debe ser un entero igual o mayor que cero.');
    }
    if (!Number.isInteger(nuevoItem.stockMinimo) || nuevoItem.stockMinimo < 0) {
      throw new Error('El stock mínimo debe ser un entero igual o mayor que cero.');
    }
    const existente = this.stock().find(
      (insumo) =>
        insumo.tipo === nuevoItem.tipo &&
        insumo.marca === nuevoItem.marca &&
        insumo.especificacion === nuevoItem.especificacion &&
        (insumo.sedeId ?? DEFAULT_SEDE_ID) === sedeId,
    );
    if (existente) {
      throw new Error(
        'Ese producto ya tiene saldo en esta sede. Usá Ajustar inventario para corregirlo.',
      );
    }

    const insumo = this.normalizarInsumo({
      ...nuevoItem,
      sedeId,
      id: this.generarId('stk'),
    });
    this.stock.update((stock) => [...stock, insumo]);
    this.registrarHistorial(
      'SALDO_INICIAL',
      `Saldo inicial: ${nuevoItem.cantidadDisponible} u. de ${nuevoItem.tipo} (${nuevoItem.marca} - ${nuevoItem.especificacion}).`,
      { insumoId: insumo.id, cantidad: nuevoItem.cantidadDisponible, sedeId },
    );
  }

  ajustarStock(insumoId: string, cantidadFinal: number, motivo: string): void {
    const insumo = this.stock().find((item) => item.id === insumoId);
    if (!insumo) throw new Error('No se encontró el producto que querés ajustar.');
    if (!Number.isInteger(cantidadFinal) || cantidadFinal < 0) {
      throw new Error('La cantidad real debe ser un entero igual o mayor que cero.');
    }
    const motivoValidado = motivo.trim();
    if (!motivoValidado || motivoValidado.length > 500) {
      throw new Error('Indicá un motivo de ajuste de hasta 500 caracteres.');
    }
    const diferencia = cantidadFinal - insumo.cantidadDisponible;
    if (diferencia === 0) {
      throw new Error('La cantidad real coincide con el saldo actual; no hace falta ajustar.');
    }

    this.stock.update((items) =>
      items.map((item) =>
        item.id === insumoId ? { ...item, cantidadDisponible: cantidadFinal } : item,
      ),
    );
    this.registrarHistorial(
      'AJUSTE_STOCK',
      `Ajuste de ${insumo.tipo} (${insumo.marca} - ${insumo.especificacion}): ${insumo.cantidadDisponible} → ${cantidadFinal} u. Motivo: ${motivoValidado}.`,
      { insumoId, cantidad: diferencia, sedeId: insumo.sedeId ?? DEFAULT_SEDE_ID },
    );
  }

  eliminarInsumoStock(id: string): void {
    this.stock.update((stock) => stock.filter((insumo) => insumo.id !== id));
  }

  editarProductoStock(
    insumoId: string,
    changes: Pick<StockInsumo, 'tipo' | 'marca' | 'especificacion' | 'stockMinimo'>,
  ): void {
    const insumo = this.stock().find((item) => item.id === insumoId);
    if (!insumo) throw new Error('No se encontró el producto que querés editar.');
    const marca = changes.marca.trim();
    const especificacion = changes.especificacion.trim();
    if (
      !marca ||
      marca.length > 120 ||
      !especificacion ||
      especificacion.length > 500 ||
      !Number.isInteger(changes.stockMinimo) ||
      changes.stockMinimo < 0
    ) {
      throw new Error('Completá los datos del producto y un stock mínimo entero no negativo.');
    }
    const siteId = insumo.sedeId ?? DEFAULT_SEDE_ID;
    if (
      this.stock().some(
        (item) =>
          item.id !== insumoId &&
          item.tipo === changes.tipo &&
          item.marca.toLocaleLowerCase() === marca.toLocaleLowerCase() &&
          item.especificacion.toLocaleLowerCase() === especificacion.toLocaleLowerCase() &&
          (item.sedeId ?? DEFAULT_SEDE_ID) === siteId,
      )
    ) {
      throw new Error('Ya existe un producto con esos datos en esta sede.');
    }
    this.stock.update((items) =>
      items.map((item) =>
        item.id === insumoId
          ? {
              ...item,
              tipo: changes.tipo,
              marca,
              especificacion,
              stockMinimo: changes.stockMinimo,
            }
          : item,
      ),
    );
  }

  crearPuestoTrabajo(
    nuevoPuesto: Omit<PuestoTrabajo, 'id' | 'codigoSeguimiento'> & {
      codigoSeguimiento?: string;
    },
  ): PuestoTrabajo {
    const assignedName = nuevoPuesto.usuarioAsignado.trim();
    const sedeId = this.sedeDeArea(nuevoPuesto.areaId);
    const existingPerson = this.personas().find(
      (persona) =>
        persona.nombre.trim().toLocaleLowerCase() === assignedName.toLocaleLowerCase() &&
        this.sedeDeArea(persona.areaId) === sedeId,
    );
    if (assignedName && existingPerson) {
      throw new Error(
        `La persona "${assignedName}" ya está registrada en un puesto. Usá Transferencias para reubicarla.`,
      );
    }
    const puesto: PuestoTrabajo = {
      ...nuevoPuesto,
      id: this.generarId('puesto'),
      codigoSeguimiento: nuevoPuesto.codigoSeguimiento ?? '',
      componentes: nuevoPuesto.componentes.map((componente) =>
        this.normalizarComponente(componente),
      ),
    };
    this.puestos.update((puestos) => [...puestos, puesto]);
    if (assignedName) {
      this.personas.update((personas) => [
        ...personas,
        {
          id: this.generarId('persona'),
          nombre: assignedName,
          areaId: puesto.areaId,
          puestoId: puesto.id,
        },
      ]);
    }
    this.registrarHistorial(
      'ALTA_PUESTO',
      `Se creó el puesto ${puesto.nombrePuesto} (Usuario: ${puesto.usuarioAsignado})`,
      { puestoId: puesto.id },
    );
    return puesto;
  }

  editarPuestoTrabajo(
    puestoId: string,
    changes: Pick<PuestoTrabajo, 'nombrePuesto' | 'usuarioAsignado'>,
  ): void {
    const puesto = this.puestos().find((item) => item.id === puestoId);
    if (!puesto) throw new Error('No se encontró el puesto que querés editar.');
    const nombrePuesto = changes.nombrePuesto.trim();
    const usuarioAsignado = changes.usuarioAsignado.trim();
    if (
      !nombrePuesto ||
      nombrePuesto.length > 120 ||
      !usuarioAsignado ||
      usuarioAsignado.length > 200
    ) {
      throw new Error('Completá el nombre del puesto y la persona asignada.');
    }
    const sedeId = this.sedeDeArea(puesto.areaId);
    if (
      this.personas().some(
        (persona) =>
          persona.puestoId !== puestoId &&
          persona.nombre.trim().toLocaleLowerCase() === usuarioAsignado.toLocaleLowerCase() &&
          this.sedeDeArea(persona.areaId) === sedeId,
      )
    ) {
      throw new Error(
        `La persona "${usuarioAsignado}" ya está registrada en otro puesto de esta sede.`,
      );
    }
    this.puestos.update((items) =>
      items.map((item) =>
        item.id === puestoId ? { ...item, nombrePuesto, usuarioAsignado } : item,
      ),
    );
    const persona = this.personas().find((item) => item.puestoId === puestoId);
    if (persona) {
      this.personas.update((items) =>
        items.map((item) =>
          item.puestoId === puestoId
            ? { ...item, nombre: usuarioAsignado, areaId: puesto.areaId }
            : item,
        ),
      );
    } else {
      this.personas.update((items) => [
        ...items,
        {
          id: this.generarId('persona'),
          nombre: usuarioAsignado,
          areaId: puesto.areaId,
          puestoId,
        },
      ]);
    }
  }

  async ejecutarTransferencia(transferencia: SolicitudTransferenciaInventario): Promise<void> {
    return this.serializarEscritura(async () => {
      const base = cloneValue(this.persistedSnapshot ?? this.obtenerInventario());
      try {
        const response = await firstValueFrom(
          this.http.post<TransferResponse>('/api/transferencias', {
            revision: this.revision,
            ...transferencia,
          }),
        );
        this.aceptarRespuestaDelServidor(response, base);
        this.errorServidor.set('');
      } catch (error: unknown) {
        const conflicto = this.registrarConflictoRevision(error);
        const message = conflicto
          ? this.mensajeConflictoRevision()
          : this.obtenerMensajeError(
              error,
              'No se pudo completar la transferencia de inventario. Los cambios locales se conservaron.',
            );
        this.errorServidor.set(message);
        throw new Error(message);
      }
    });
  }

  async listarTransferencias(
    filters: InventoryTransferFilters,
  ): Promise<PagedResult<TransferenciaInventario>> {
    let params = new HttpParams()
      .set('page', filters.page)
      .set('pageSize', filters.pageSize)
      .set('sort', filters.sort);
    for (const key of ['search', 'site', 'area', 'operator', 'from', 'to', 'type'] as const) {
      const value = filters[key].trim();
      if (value) params = params.set(key, value);
    }
    try {
      return await firstValueFrom(
        this.http.get<PagedResult<TransferenciaInventario>>('/api/transferencias', { params }),
      );
    } catch (error: unknown) {
      throw new Error(
        this.obtenerMensajeError(error, 'No se pudo cargar el historial de transferencias.'),
      );
    }
  }

  agregarComponenteManual(
    puestoId: string,
    nuevoComponente: Omit<ComponentePuesto, 'id' | 'codigoSeguimiento'>,
  ): ComponentePuesto {
    const puesto = this.puestos().find((item) => item.id === puestoId);
    if (!puesto) {
      throw new Error(`No se encontró el puesto "${puestoId}".`);
    }

    const componente = this.normalizarComponente({
      ...nuevoComponente,
      id: this.generarId('comp'),
    });
    this.puestos.update((puestos) =>
      puestos.map((item) =>
        item.id === puestoId ? { ...item, componentes: [...item.componentes, componente] } : item,
      ),
    );
    this.registrarHistorial(
      'ALTA_COMPONENTE',
      `Se relevó ${componente.tipo} (${componente.marca}${componente.modelo ? ` ${componente.modelo}` : ''} - ${componente.especificacion}) en ${puesto.nombrePuesto}.`,
      { puestoId },
    );
    return componente;
  }

  eliminarPuestoTrabajo(puestoId: string): void {
    const puesto = this.puestos().find((item) => item.id === puestoId);
    if (!puesto) {
      return;
    }
    const sedeId = this.sedeDeArea(puesto.areaId);

    this.puestos.update((puestos) => puestos.filter((item) => item.id !== puestoId));
    this.personas.update((personas) =>
      personas.map((persona) =>
        persona.puestoId === puestoId ? { ...persona, puestoId: null } : persona,
      ),
    );
    this.registrarHistorial(
      'BAJA_PUESTO',
      `Se eliminó el puesto ${puesto.nombrePuesto} (Usuario: ${puesto.usuarioAsignado})`,
      { puestoId, cantidad: 1, sedeId },
    );
  }

  reemplazarComponente(
    puestoId: string,
    componenteActualId: string,
    insumoStockId: string,
    motivo: string,
    estadoComponenteRetirado: EstadoComponenteRetirado = 'REPARACION',
  ): void {
    const puesto = this.puestos().find((item) => item.id === puestoId);
    if (!puesto) {
      throw new Error(`No se encontró el puesto "${puestoId}".`);
    }

    const insumo = this.stock().find((item) => item.id === insumoStockId);
    if (!insumo || insumo.cantidadDisponible <= 0) {
      throw new Error('No hay suficiente stock disponible de este insumo.');
    }
    if ((insumo.sedeId ?? DEFAULT_SEDE_ID) !== this.sedeDeArea(puesto.areaId)) {
      throw new Error('El repuesto seleccionado pertenece a otra sede.');
    }
    const componenteActual = puesto.componentes.find(
      (componente) => componente.id === componenteActualId,
    );
    if (!componenteActual) {
      throw new Error(`No se encontró el componente saliente en "${puesto.nombrePuesto}".`);
    }
    const motivoValidado = motivo.trim();
    if (!motivoValidado || motivoValidado.length > 500) {
      throw new Error('Ingresá un motivo de reemplazo de hasta 500 caracteres.');
    }

    const componenteNuevo = this.normalizarComponente({
      id: this.generarId('comp'),
      tipo: insumo.tipo,
      marca: insumo.marca,
      especificacion: insumo.especificacion,
    });
    const fechaRetiro = new Date();
    const retirado: ComponenteRetirado = {
      id: this.generarId('ret'),
      componente: componenteActual,
      puestoId: puesto.id,
      puestoNombre: puesto.nombrePuesto,
      sedeId: this.sedeDeArea(puesto.areaId),
      estado: estadoComponenteRetirado,
      fechaRetiro,
    };

    this.stock.update((stock) =>
      stock.map((item) =>
        item.id === insumoStockId
          ? { ...item, cantidadDisponible: item.cantidadDisponible - 1 }
          : item,
      ),
    );
    this.puestos.update((puestos) =>
      puestos.map((item) =>
        item.id === puestoId
          ? {
              ...item,
              componentes: [
                ...item.componentes.filter((componente) => componente.id !== componenteActual.id),
                componenteNuevo,
              ],
            }
          : item,
      ),
    );
    this.componentesRetirados.update((componentes) => [retirado, ...componentes]);
    this.registrarHistorial(
      'REEMPLAZO_PUESTO',
      `Se instaló ${insumo.tipo} (${insumo.marca} - ${insumo.especificacion}) en ${puesto.nombrePuesto} (Usuario: ${puesto.usuarioAsignado}). Motivo: ${motivoValidado}.`,
      { insumoId: insumo.id, puestoId: puesto.id, sedeId: insumo.sedeId ?? DEFAULT_SEDE_ID },
    );
    this.registrarHistorial(
      'RETIRO_COMPONENTE',
      `Se retiró ${componenteActual.tipo} ${componenteActual.marca} ${componenteActual.especificacion} de ${puesto.nombrePuesto}; estado inicial: ${estadoComponenteRetirado}. Motivo: ${motivoValidado}.`,
      {
        puestoId: puesto.id,
        componenteRetiradoId: retirado.id,
        sedeId: this.sedeDeArea(puesto.areaId),
      },
    );
  }

  cambiarEstadoComponenteRetirado(
    componenteRetiradoId: string,
    nuevoEstado: EstadoComponenteRetirado,
  ): void {
    const retirado = this.componentesRetirados().find((item) => item.id === componenteRetiradoId);
    if (!retirado) {
      throw new Error(`No se encontró el componente retirado "${componenteRetiradoId}".`);
    }
    if (retirado.estado === nuevoEstado) {
      return;
    }

    this.componentesRetirados.update((componentes) =>
      componentes.map((item) =>
        item.id === componenteRetiradoId ? { ...item, estado: nuevoEstado } : item,
      ),
    );
    this.registrarHistorial(
      'CAMBIO_ESTADO_COMPONENTE',
      `El componente ${retirado.componente.tipo} ${retirado.componente.marca} de ${retirado.puestoNombre} cambió de ${retirado.estado} a ${nuevoEstado}.`,
      {
        puestoId: retirado.puestoId,
        componenteRetiradoId,
        sedeId: retirado.sedeId ?? DEFAULT_SEDE_ID,
      },
    );
  }
}

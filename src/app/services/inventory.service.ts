import { HttpClient, HttpErrorResponse } from '@angular/common/http';
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
  PuestoTrabajo,
  StockInsumo,
  TipoEquipoRed,
  TipoMovimiento,
  TipoPeriferico,
} from '../models/inventory.model';

export interface InventoryData {
  pisos: Piso[];
  areas: Area[];
  stock: StockInsumo[];
  puestos: PuestoTrabajo[];
  equiposRed: EquipoRed[];
  componentesRetirados: ComponenteRetirado[];
  historial: HistorialMovimiento[];
}

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

@Injectable({
  providedIn: 'root',
})
export class InventoryService {
  private readonly http = inject(HttpClient);
  private idSequence = 0;
  private revision = 0;
  private persistedSnapshot: InventoryData | null = null;

  readonly pisos = signal<Piso[]>([]);
  readonly areas = signal<Area[]>([]);
  readonly stock = signal<StockInsumo[]>([]);
  readonly puestos = signal<PuestoTrabajo[]>([]);
  readonly equiposRed = signal<EquipoRed[]>([]);
  readonly componentesRetirados = signal<ComponenteRetirado[]>([]);
  readonly historial = signal<HistorialMovimiento[]>([]);
  readonly cargando = signal(false);
  readonly errorCarga = signal('');
  readonly errorServidor = signal('');

  async cargarDesdeServidor(): Promise<void> {
    this.cargando.set(true);
    this.errorCarga.set('');
    this.errorServidor.set('');
    try {
      const response = await firstValueFrom(this.http.get<InventoryResponse>('/api/inventory'));
      this.revision = Number(response.revision);
      this.aplicarInventario(response.payload);
      this.persistedSnapshot = this.obtenerInventario();
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

  async guardarEnServidor(): Promise<void> {
    const payload = this.obtenerInventario();
    try {
      const response = await firstValueFrom(
        this.http.put<InventoryResponse>('/api/inventory', {
          revision: this.revision,
          payload,
        }),
      );
      this.revision = Number(response.revision);
      this.aplicarInventario(response.payload);
      this.persistedSnapshot = this.obtenerInventario();
      this.errorServidor.set('');
    } catch (error: unknown) {
      const remote = error instanceof HttpErrorResponse ? error.error : null;
      if (
        error instanceof HttpErrorResponse &&
        error.status === 409 &&
        remote &&
        typeof remote.revision === 'string' &&
        this.esInventario(remote.payload)
      ) {
        this.revision = Number(remote.revision);
        this.aplicarInventario(remote.payload);
        this.persistedSnapshot = this.obtenerInventario();
      } else if (this.persistedSnapshot) {
        this.aplicarInventario(this.persistedSnapshot);
      }
      const message = this.obtenerMensajeError(
        error,
        'No se pudieron guardar los cambios en el servidor.',
      );
      this.errorServidor.set(message);
      throw new Error(message);
    }
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
    if (
      !value ||
      typeof value !== 'object' ||
      !('format' in value) ||
      value.format !== 'gestion-it-backup' ||
      !('version' in value) ||
      value.version !== 1 ||
      !('inventory' in value) ||
      !this.esInventario(value.inventory)
    ) {
      throw new Error('El archivo no es un respaldo válido de Gestión IT.');
    }
    try {
      const response = await firstValueFrom(
        this.http.post<InventoryResponse>('/api/inventory/import', {
          payload: value.inventory,
        }),
      );
      this.revision = Number(response.revision);
      this.aplicarInventario(response.payload);
      this.persistedSnapshot = this.obtenerInventario();
    } catch (error: unknown) {
      throw new Error(
        this.obtenerMensajeError(error, 'No se pudo importar el respaldo en el servidor.'),
      );
    }
  }

  private esInventario(value: unknown): value is InventoryData {
    if (!value || typeof value !== 'object') return false;
    const inventory = value as Record<string, unknown>;
    return [
      'pisos',
      'areas',
      'stock',
      'puestos',
      'equiposRed',
      'componentesRetirados',
      'historial',
    ].every((key) => Array.isArray(inventory[key]));
  }

  private obtenerInventario(): InventoryData {
    return {
      pisos: this.pisos(),
      areas: this.areas(),
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
    } = {},
  ): void {
    const movimiento: HistorialMovimiento = {
      id: this.generarId('hist'),
      fecha: new Date(),
      tipo,
      cantidad: opciones.cantidad ?? 1,
      detalle,
      ...(opciones.insumoId ? { insumoId: opciones.insumoId } : {}),
      ...(opciones.puestoId ? { puestoId: opciones.puestoId } : {}),
      ...(opciones.equipoRedId ? { equipoRedId: opciones.equipoRedId } : {}),
      ...(opciones.componenteRetiradoId
        ? { componenteRetiradoId: opciones.componenteRetiradoId }
        : {}),
    };
    this.historial.update((registros) => [movimiento, ...registros]);
  }

  crearPiso(nombre: string, nivel: number): Piso {
    const nuevoPiso: Piso = { id: this.generarId('piso'), nombre, nivel };
    this.pisos.update((pisos) => [...pisos, nuevoPiso]);
    return nuevoPiso;
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
    this.registrarHistorial(
      'ALTA_EQUIPO_RED',
      `Se registró un ${equipo.tipo} ${equipo.marca} ${equipo.modelo} en el área ${equipo.areaId}.`,
      { equipoRedId: equipo.id },
    );
    return equipo;
  }

  eliminarEquipoRed(equipoRedId: string): void {
    const equipo = this.equiposRed().find((item) => item.id === equipoRedId);
    if (!equipo) {
      return;
    }
    this.equiposRed.update((equipos) => equipos.filter((item) => item.id !== equipoRedId));
    this.registrarHistorial(
      'BAJA_EQUIPO_RED',
      `Se eliminó el ${equipo.tipo} ${equipo.marca} ${equipo.modelo} del área ${equipo.areaId}.`,
      { equipoRedId: equipo.id },
    );
  }

  agregarInsumoStock(nuevoItem: Omit<StockInsumo, 'id' | 'codigoSeguimiento'>): void {
    if (!Number.isInteger(nuevoItem.cantidadDisponible) || nuevoItem.cantidadDisponible <= 0) {
      throw new Error('La cantidad a ingresar debe ser un entero mayor que cero.');
    }

    const existente = this.stock().find(
      (insumo) =>
        insumo.tipo === nuevoItem.tipo &&
        insumo.marca === nuevoItem.marca &&
        insumo.especificacion === nuevoItem.especificacion,
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
      const nuevoInsumo = this.normalizarInsumo({ ...nuevoItem, id: idInsumo });
      this.stock.update((stock) => [...stock, nuevoInsumo]);
    }

    this.registrarHistorial(
      'INGRESO_STOCK',
      `Ingreso de stock: +${nuevoItem.cantidadDisponible} u. de ${nuevoItem.tipo} (${nuevoItem.marca} - ${nuevoItem.especificacion})`,
      { insumoId: idInsumo, cantidad: nuevoItem.cantidadDisponible },
    );
  }

  eliminarInsumoStock(id: string): void {
    this.stock.update((stock) => stock.filter((insumo) => insumo.id !== id));
  }

  crearPuestoTrabajo(
    nuevoPuesto: Omit<PuestoTrabajo, 'id' | 'codigoSeguimiento'> & {
      codigoSeguimiento?: string;
    },
  ): PuestoTrabajo {
    const puesto: PuestoTrabajo = {
      ...nuevoPuesto,
      id: this.generarId('puesto'),
      codigoSeguimiento: nuevoPuesto.codigoSeguimiento ?? '',
      componentes: nuevoPuesto.componentes.map((componente) =>
        this.normalizarComponente(componente),
      ),
    };
    this.puestos.update((puestos) => [...puestos, puesto]);
    this.registrarHistorial(
      'ALTA_PUESTO',
      `Se creó el puesto ${puesto.nombrePuesto} (Usuario: ${puesto.usuarioAsignado})`,
      { puestoId: puesto.id },
    );
    return puesto;
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

    this.puestos.update((puestos) => puestos.filter((item) => item.id !== puestoId));
    this.registrarHistorial(
      'BAJA_PUESTO',
      `Se eliminó el puesto ${puesto.nombrePuesto} (Usuario: ${puesto.usuarioAsignado})`,
      { puestoId, cantidad: 1 },
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
      { insumoId: insumo.id, puestoId: puesto.id },
    );
    this.registrarHistorial(
      'RETIRO_COMPONENTE',
      `Se retiró ${componenteActual.tipo} ${componenteActual.marca} ${componenteActual.especificacion} de ${puesto.nombrePuesto}; estado inicial: ${estadoComponenteRetirado}. Motivo: ${motivoValidado}.`,
      { puestoId: puesto.id, componenteRetiradoId: retirado.id },
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
      { puestoId: retirado.puestoId, componenteRetiradoId },
    );
  }
}

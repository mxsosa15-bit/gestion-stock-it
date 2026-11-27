import {
  ChangeDetectorRef,
  Component,
  ElementRef,
  inject,
  OnDestroy,
  QueryList,
  signal,
  computed,
  ViewChild,
  ViewChildren,
} from '@angular/core';
import { CommonModule, NgOptimizedImage } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { InventoryService } from './services/inventory.service';
import { AuthService, type ManagedUser, type SystemRole } from './services/auth.service';
import { AssetLabelsComponent } from './components/asset-labels/asset-labels.component';
import { AreaAssetsExplorerComponent } from './components/area-assets-explorer/area-assets-explorer.component';
import { SupportTicketsComponent } from './components/support-tickets/support-tickets.component';
import { ReadOnlyDashboardComponent } from './components/read-only-dashboard/read-only-dashboard.component';
import { OperationsDashboardComponent } from './components/operations-dashboard/operations-dashboard.component';
import { WorkshopTicketsComponent } from './components/workshop-tickets/workshop-tickets.component';
import { InventoryTransfersComponent } from './components/inventory-transfers/inventory-transfers.component';
import { OperatorAuditComponent } from './components/operator-audit/operator-audit.component';
import { OperatorTasksComponent } from './components/operator-tasks/operator-tasks.component';
import { ReportsComponent } from './components/reports/reports.component';
import { StockDispatchComponent } from './components/stock-dispatch/stock-dispatch.component';
import { LocationsService } from './services/locations.service';
import { OperatorTasksService } from './services/operator-tasks.service';
import type { NewLocation } from './services/locations.service';
import { TicketsService } from './services/tickets.service';
import { HardwareAssetsService } from './services/hardware-assets.service';
import { DEFAULT_SEDE_ID } from '../shared/locations';
import {
  EquipoRed,
  EstadoComponenteRetirado,
  HistorialMovimiento,
  PuestoTrabajo,
  Sede,
  StockInsumo,
  TipoEquipoRed,
  TipoPeriferico,
} from './models/inventory.model';
import type { ComponentePuesto } from './models/inventory.model';
import type { ComponentEdit } from './services/inventory.service';
import type { WorkSheet } from 'xlsx-js-style';

type ModalActivo =
  | 'NUEVO_PUESTO'
  | 'NUEVO_COMPONENTE'
  | 'NUEVO_STOCK'
  | 'SALDO_INICIAL'
  | 'AJUSTE_STOCK'
  | 'NUEVO_PISO'
  | 'NUEVA_AREA'
  | 'NUEVO_EQUIPO_RED'
  | null;

type VistaActiva =
  | 'DASHBOARD'
  | 'PARQUE'
  | 'STOCK'
  | 'EDIFICIO'
  | 'REPORTES'
  | 'REDES'
  | 'TALLER'
  | 'PATRIMONIO'
  | 'TICKETS'
  | 'TRANSFERENCIAS'
  | 'AUDITORIA'
  | 'TAREAS';

type TipoConfirmacion = 'PUESTO' | 'STOCK' | 'PISO' | 'AREA' | 'RED';

interface ConfirmacionPendiente {
  tipo: TipoConfirmacion;
  id: string;
  nombre: string;
}

interface ToastNotification {
  tipo: 'success' | 'error';
  mensaje: string;
}

interface EditorComponente {
  puestoId: string;
  id: string;
  tipo: TipoPeriferico;
  marca: string;
  modelo: string;
  especificacion: string;
  numeroSerie: string;
  codigoSeguimiento: string;
  motivo: string;
}

interface EditorRegistroInventario {
  tipo: 'PUESTO' | 'STOCK' | 'RED' | 'AREA' | 'PISO';
  id: string;
  nombrePuesto: string;
  usuarioAsignado: string;
  tipoStock: TipoPeriferico;
  marca: string;
  especificacion: string;
  stockMinimo: number;
  tipoRed: TipoEquipoRed;
  modelo: string;
  nombreArea: string;
  nombrePiso: string;
  nivelPiso: number;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    NgOptimizedImage,
    AssetLabelsComponent,
    AreaAssetsExplorerComponent,
    SupportTicketsComponent,
    ReadOnlyDashboardComponent,
    OperationsDashboardComponent,
    WorkshopTicketsComponent,
    InventoryTransfersComponent,
    OperatorAuditComponent,
    OperatorTasksComponent,
    ReportsComponent,
    StockDispatchComponent,
  ],
  templateUrl: './app.html',
})
export class App implements OnDestroy {
  inventoryService = inject(InventoryService);
  readonly authService = inject(AuthService);
  readonly locationsService = inject(LocationsService);
  readonly operatorTasksService = inject(OperatorTasksService);
  readonly ticketsService = inject(TicketsService);
  readonly hardwareAssetsService = inject(HardwareAssetsService);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private toastTimer?: ReturnType<typeof setTimeout>;
  readonly authUsuario = signal('');
  readonly authContrasena = signal('');
  readonly backupImportando = signal(false);
  readonly resolviendoConflicto = signal(false);
  readonly guardandoModal = signal(false);
  readonly eliminandoRegistro = signal(false);
  readonly componenteEstadoActualizandoId = signal<string | null>(null);
  readonly nuevoUsuario = signal({
    username: '',
    password: '',
    role: 'operator' as SystemRole,
    areaId: '',
  });
  readonly usuarioParaRestablecer = signal<string | null>(null);
  readonly nuevaContrasena = signal('');
  readonly usuarioRestableciendo = signal<string | null>(null);
  readonly usuarioEnEdicion = signal<string | null>(null);
  readonly usuarioEdicion = signal<{ role: SystemRole; areaId: string }>({
    role: 'operator',
    areaId: '',
  });
  readonly usuarioActualizando = signal<string | null>(null);
  readonly sedeSeleccionadaId = signal(DEFAULT_SEDE_ID);
  readonly sedes = this.locationsService.sedes;
  readonly sedeSeleccionada = computed(
    () => this.sedes().find((sede) => sede.id === this.sedeSeleccionadaId()) ?? null,
  );
  readonly nuevaSede = signal<NewLocation>({
    nombre: '',
    departamento: '',
    localidad: '',
    direccion: '',
  });
  readonly sedeReporteId = signal('TODAS');
  readonly creandoSede = signal(false);
  readonly errorSedes = signal('');
  readonly insumoEnAjusteId = signal('');
  readonly cantidadAjuste = signal(0);
  readonly motivoAjuste = signal('');
  readonly insumoEnAjuste = computed(
    () => this.stock().find((item) => item.id === this.insumoEnAjusteId()) ?? null,
  );
  readonly componenteEnEdicion = signal<EditorComponente | null>(null);
  readonly errorEdicionComponente = signal('');
  readonly guardandoEdicionComponente = signal(false);
  readonly registroEnEdicion = signal<EditorRegistroInventario | null>(null);
  readonly guardandoEdicionInventario = signal(false);
  readonly sedeEnEdicionId = signal<string | null>(null);
  readonly sedeEdicion = signal<NewLocation>({
    nombre: '',
    departamento: '',
    localidad: '',
    direccion: '',
  });
  readonly actualizandoSede = signal(false);
  readonly errorEdicionSede = signal('');

  constructor() {
    void this.inicializarSesion();
  }

  private async inicializarSesion(): Promise<void> {
    await this.authService.initialize();
    const user = this.authService.user();
    if (user?.role === 'solicitante') {
      this.vistaActiva.set('TICKETS');
    } else if (user) {
      await this.cargarInventario();
    }
  }

  private async cargarInventario(): Promise<void> {
    try {
      await this.inventoryService.cargarDesdeServidor();
      if (this.authService.user()?.role !== 'dashboard') {
        await this.locationsService.cargar();
      }
      if (!this.sedes().some((sede) => sede.id === this.sedeSeleccionadaId())) {
        this.sedeSeleccionadaId.set(this.sedes()[0]?.id ?? DEFAULT_SEDE_ID);
      }
    } catch {
      if (this.locationsService.error()) this.mostrarToast(this.locationsService.error(), 'error');
    }
  }

  async iniciarSesion(): Promise<void> {
    const username = this.authUsuario().trim();
    const password = this.authContrasena();
    try {
      if (this.authService.setupRequired()) {
        await this.authService.configurarAdministrador(username, password);
      } else {
        await this.authService.iniciarSesion(username, password);
      }
      this.authContrasena.set('');
      if (this.authService.user()?.role === 'solicitante') {
        this.vistaActiva.set('TICKETS');
      } else {
        await this.cargarInventario();
      }
    } catch {
      // AuthService and InventoryService expose actionable errors to the template.
    }
  }

  async reintentarConexion(): Promise<void> {
    if (this.authService.user()) {
      await this.cargarInventario();
      return;
    }
    await this.authService.initialize();
  }

  async cerrarSesion(): Promise<void> {
    try {
      await this.authService.cerrarSesion();
      this.authUsuario.set('');
      this.authContrasena.set('');
    } catch {
      this.mostrarToast(this.authService.error(), 'error');
    }
  }

  exportarRespaldoJson(): void {
    this.descargarJson(
      this.inventoryService.exportarRespaldo(),
      `gestion-it-respaldo-${new Date().toISOString().slice(0, 10)}.json`,
    );
    this.mostrarToast('Se descargó el respaldo del inventario.');
  }

  descargarVersionConflicto(origen: 'local' | 'servidor'): void {
    const conflicto = this.inventoryService.conflictoInventario();
    if (!conflicto) return;

    const respaldo =
      origen === 'local'
        ? this.inventoryService.exportarRespaldo()
        : {
            format: 'gestion-it-backup' as const,
            version: 1 as const,
            createdAt: new Date().toISOString(),
            inventory: conflicto.payload,
          };
    const fecha = new Date().toISOString().slice(0, 10);
    this.descargarJson(respaldo, `gestion-it-conflicto-${origen}-${fecha}.json`);
    this.mostrarToast(
      `Se descargó la versión ${origen === 'local' ? 'local' : 'del servidor'}.`,
    );
  }

  async resolverConflictoJson(event: Event): Promise<void> {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const archivo = input.files?.[0];
    if (!archivo || this.resolviendoConflicto()) return;

    this.resolviendoConflicto.set(true);
    try {
      const respaldo: unknown = JSON.parse(await archivo.text());
      if (
        !window.confirm(
          `¿Confirmás guardar la versión combinada "${archivo.name}"?\n\nSe usará como inventario completo y se enviará con la última revisión del servidor. Verificá que el archivo incluya los cambios que querés conservar de ambas versiones.`,
        )
      ) {
        return;
      }
      await this.inventoryService.resolverConflictoConRespaldo(respaldo);
      this.mostrarToast('Se resolvió el conflicto y se guardó la versión combinada.');
    } catch (error: unknown) {
      this.mostrarToast(
        error instanceof Error ? error.message : 'No se pudo resolver el conflicto.',
        'error',
      );
    } finally {
      this.resolviendoConflicto.set(false);
      input.value = '';
    }
  }

  private descargarJson(respaldo: unknown, nombreArchivo: string): void {
    const contenido = new Blob([JSON.stringify(respaldo, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(contenido);
    const enlace = document.createElement('a');
    enlace.href = url;
    enlace.download = nombreArchivo;
    enlace.click();
    URL.revokeObjectURL(url);
  }

  async importarRespaldoJson(event: Event): Promise<void> {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const archivo = input.files?.[0];
    if (!archivo || this.backupImportando()) return;

    this.backupImportando.set(true);
    try {
      const respaldo: unknown = JSON.parse(await archivo.text());
      if (
        !window.confirm(
          `¿Confirmás restaurar el respaldo "${archivo.name}"? Esta operación importará sus datos al inventario disponible.`,
        )
      ) {
        return;
      }
      await this.inventoryService.importarRespaldo(respaldo);
      this.mostrarToast('Se restauró el respaldo en el servidor.');
    } catch (error: unknown) {
      this.mostrarToast(
        error instanceof Error ? error.message : 'No se pudo importar el respaldo.',
        'error',
      );
    } finally {
      this.backupImportando.set(false);
      input.value = '';
    }
  }

  // Navegación por pestañas
  vistaActiva = signal<VistaActiva>('DASHBOARD');
  readonly menuMovilAbierto = signal(false);
  readonly tituloVista = computed(() => {
    const titulos: Record<VistaActiva, string> = {
      DASHBOARD: 'Dashboard operativo',
      PARQUE: 'Gestión de Parque IT',
      STOCK: 'Depósito y Stock',
      EDIFICIO: 'Gestión de Pisos y Áreas',
      REPORTES: 'Reportes e Historial',
      REDES: 'Gestión de Redes',
      TALLER: 'Taller y Scrap',
      PATRIMONIO: 'Etiquetas de patrimonio',
      TICKETS: 'Reclamos de soporte',
      TRANSFERENCIAS: 'Transferencias y mudanzas',
      AUDITORIA: 'Auditoría de operadores',
      TAREAS: 'Registro de actividades',
    };
    return titulos[this.vistaActiva()];
  });
  readonly modalActivo = signal<ModalActivo>(null);
  readonly reemplazoModalAbierto = signal(false);
  readonly reemplazoGuardando = signal(false);
  readonly reemplazoError = signal('');
  readonly reemplazoConfirmado = signal(false);
  readonly reemplazoPuestoId = signal('');
  readonly reemplazoComponenteId = signal('');
  readonly reemplazoStockId = signal('');
  readonly reemplazoStockBusqueda = signal('');
  readonly reemplazoMotivoTipo = signal('Falla');
  readonly reemplazoMotivoDetalle = signal('');
  readonly motivosReemplazo = ['Falla', 'Obsolescencia', 'Mejora', 'Otro'] as const;
  readonly reemplazoPuesto = computed(
    () => this.puestos().find((puesto) => puesto.id === this.reemplazoPuestoId()) ?? null,
  );
  readonly componentesDelReemplazo = computed(() => this.reemplazoPuesto()?.componentes ?? []);
  readonly componenteSaliente = computed(
    () =>
      this.componentesDelReemplazo().find(
        (componente) => componente.id === this.reemplazoComponenteId(),
      ) ?? null,
  );
  readonly opcionesStockReemplazo = computed(() =>
    this.stock()
      .filter((insumo) => insumo.cantidadDisponible > 0)
      .map((insumo, index) => ({
        id: insumo.id,
        label: this.etiquetaStockReemplazo(insumo, index),
      })),
  );
  readonly insumoEntrante = computed(() => {
    const insumo = this.stock().find((item) => item.id === this.reemplazoStockId());
    return insumo && insumo.cantidadDisponible > 0 ? insumo : null;
  });
  readonly motivoReemplazo = computed(() => {
    const tipo = this.reemplazoMotivoTipo();
    const detalle = this.reemplazoMotivoDetalle().trim();
    return detalle ? `${tipo}: ${detalle}` : tipo;
  });
  readonly errorFormulario = signal('');
  readonly toast = signal<ToastNotification | null>(null);
  readonly confirmacionPendiente = signal<ConfirmacionPendiente | null>(null);
  readonly puestoComponenteId = signal<string | null>(null);
  readonly nuevoComponenteManual = signal({
    tipo: 'MONITOR' as TipoPeriferico,
    marca: '',
    modelo: '',
    caracteristicas: '',
  });
  readonly tipoComponenteManualExterno = computed(() =>
    this.tiposPerifericosExternos.includes(this.nuevoComponenteManual().tipo),
  );

  // Señales del servicio
  readonly pisos = computed(() =>
    this.inventoryService
      .pisos()
      .filter((piso) => (piso.sedeId ?? DEFAULT_SEDE_ID) === this.sedeSeleccionadaId()),
  );
  readonly areas = computed(() => {
    const pisoIds = new Set(this.pisos().map((piso) => piso.id));
    return this.inventoryService.areas().filter((area) => pisoIds.has(area.pisoId));
  });
  readonly puestos = computed(() => {
    const areaIds = new Set(this.areas().map((area) => area.id));
    return this.inventoryService.puestos().filter((puesto) => areaIds.has(puesto.areaId));
  });
  readonly stock = computed(() =>
    this.inventoryService
      .stock()
      .filter((insumo) => (insumo.sedeId ?? DEFAULT_SEDE_ID) === this.sedeSeleccionadaId()),
  );
  readonly equiposRed = computed(() => {
    const areaIds = new Set(this.areas().map((area) => area.id));
    return this.inventoryService.equiposRed().filter((equipo) => areaIds.has(equipo.areaId));
  });
  readonly busquedaStock = signal('');
  readonly tipoStockFiltro = signal('');
  readonly estadoStockFiltro = signal<'TODOS' | 'BAJO' | 'SIN_STOCK' | 'DISPONIBLE'>('TODOS');
  readonly ordenStock = signal<'NOMBRE' | 'CANTIDAD_ASC' | 'CANTIDAD_DESC'>('NOMBRE');
  readonly paginaStock = signal(1);
  readonly stockPorPagina = 25;
  readonly stockFiltrado = computed(() => {
    let result = this.stock();
    const search = this.normalizarBusqueda(this.busquedaStock());
    const type = this.tipoStockFiltro();
    const state = this.estadoStockFiltro();
    if (type) result = result.filter((item) => item.tipo === type);
    if (state === 'BAJO') {
      result = result.filter(
        (item) => item.cantidadDisponible > 0 && item.cantidadDisponible <= item.stockMinimo,
      );
    } else if (state === 'SIN_STOCK') {
      result = result.filter((item) => item.cantidadDisponible === 0);
    } else if (state === 'DISPONIBLE') {
      result = result.filter((item) => item.cantidadDisponible > item.stockMinimo);
    }
    if (search) {
      result = result.filter((item) =>
        this.normalizarBusqueda(
          [item.tipo, item.marca, item.especificacion, item.codigoSeguimiento ?? ''].join(' '),
        ).includes(search),
      );
    }
    return [...result].sort((left, right) => {
      if (this.ordenStock() === 'CANTIDAD_ASC') {
        return left.cantidadDisponible - right.cantidadDisponible || left.marca.localeCompare(right.marca);
      }
      if (this.ordenStock() === 'CANTIDAD_DESC') {
        return right.cantidadDisponible - left.cantidadDisponible || left.marca.localeCompare(right.marca);
      }
      return left.marca.localeCompare(right.marca, 'es') || left.tipo.localeCompare(right.tipo, 'es');
    });
  });
  readonly paginasStock = computed(() =>
    Math.max(1, Math.ceil(this.stockFiltrado().length / this.stockPorPagina)),
  );
  readonly stockPaginado = computed(() => {
    const page = Math.min(this.paginaStock(), this.paginasStock());
    const start = (page - 1) * this.stockPorPagina;
    return this.stockFiltrado().slice(start, start + this.stockPorPagina);
  });
  readonly busquedaRed = signal('');
  readonly tipoRedFiltro = signal('');
  readonly areaRedFiltro = signal('TODAS');
  readonly ordenRed = signal<'MARCA' | 'TIPO' | 'AREA'>('MARCA');
  readonly paginaRed = signal(1);
  readonly redPorPagina = 25;
  readonly equiposRedFiltrados = computed(() => {
    let result = this.equiposRed();
    const search = this.normalizarBusqueda(this.busquedaRed());
    const type = this.tipoRedFiltro();
    const area = this.areaRedFiltro();
    if (type) result = result.filter((item) => item.tipo === type);
    if (area !== 'TODAS') result = result.filter((item) => item.areaId === area);
    if (search) {
      result = result.filter((item) => {
        const areaName = this.areas().find((candidate) => candidate.id === item.areaId)?.nombre ?? '';
        return this.normalizarBusqueda(
          [item.tipo, item.marca, item.modelo, item.codigoSeguimiento, areaName].join(' '),
        ).includes(search);
      });
    }
    return [...result].sort((left, right) => {
      if (this.ordenRed() === 'TIPO') {
        return left.tipo.localeCompare(right.tipo, 'es') || left.marca.localeCompare(right.marca, 'es');
      }
      if (this.ordenRed() === 'AREA') {
        const leftArea = this.areas().find((item) => item.id === left.areaId)?.nombre ?? '';
        const rightArea = this.areas().find((item) => item.id === right.areaId)?.nombre ?? '';
        return leftArea.localeCompare(rightArea, 'es') || left.marca.localeCompare(right.marca, 'es');
      }
      return left.marca.localeCompare(right.marca, 'es') || left.modelo.localeCompare(right.modelo, 'es');
    });
  });
  readonly paginasRed = computed(() =>
    Math.max(1, Math.ceil(this.equiposRedFiltrados().length / this.redPorPagina)),
  );
  readonly equiposRedPaginados = computed(() => {
    const page = Math.min(this.paginaRed(), this.paginasRed());
    const start = (page - 1) * this.redPorPagina;
    return this.equiposRedFiltrados().slice(start, start + this.redPorPagina);
  });
  readonly componentesRetirados = computed(() => {
    const puestosPorId = new Map(
      this.inventoryService.puestos().map((puesto) => [puesto.id, puesto]),
    );
    return this.inventoryService.componentesRetirados().filter((componente) => {
      const puesto = puestosPorId.get(componente.puestoId);
      const area = puesto
        ? this.inventoryService.areas().find((item) => item.id === puesto.areaId)
        : undefined;
      const piso = area
        ? this.inventoryService.pisos().find((item) => item.id === area.pisoId)
        : undefined;
      return (componente.sedeId ?? piso?.sedeId ?? DEFAULT_SEDE_ID) === this.sedeSeleccionadaId();
    });
  });
  historial = this.inventoryService.historial;
  readonly busquedaActividad = signal('');
  readonly tipoActividadFiltro = signal('');
  readonly operadorActividadFiltro = signal('');
  readonly sedeActividadFiltro = signal('TODAS');
  readonly desdeActividad = signal('');
  readonly hastaActividad = signal('');
  readonly ordenActividad = signal<'NEWEST' | 'OLDEST'>('NEWEST');
  readonly paginaActividad = signal(1);
  readonly actividadPorPagina = 25;
  readonly tiposActividad = computed(() =>
    [...new Set(this.historial().map((item) => item.tipo))].sort((left, right) =>
      left.localeCompare(right, 'es'),
    ),
  );
  readonly actividadFiltrada = computed(() => {
    let result = this.historial();
    const search = this.normalizarBusqueda(this.busquedaActividad());
    const operator = this.normalizarBusqueda(this.operadorActividadFiltro());
    const site = this.sedeActividadFiltro();
    if (this.tipoActividadFiltro()) {
      result = result.filter((item) => item.tipo === this.tipoActividadFiltro());
    }
    if (operator) {
      result = result.filter((item) => this.normalizarBusqueda(item.operador ?? '').includes(operator));
    }
    if (site !== 'TODAS') {
      result = result.filter(
        (item) => item.sedeId === site || item.sedeDestinoId === site,
      );
    }
    if (this.desdeActividad()) {
      result = result.filter(
        (item) => this.fechaLocalIso(item.fecha) >= this.desdeActividad(),
      );
    }
    if (this.hastaActividad()) {
      result = result.filter(
        (item) => this.fechaLocalIso(item.fecha) <= this.hastaActividad(),
      );
    }
    if (search) {
      result = result.filter((item) =>
        this.normalizarBusqueda([item.tipo, item.detalle, item.operador ?? ''].join(' ')).includes(search),
      );
    }
    return [...result].sort((left, right) => {
      const direction = this.ordenActividad() === 'NEWEST' ? -1 : 1;
      return direction * (new Date(left.fecha).getTime() - new Date(right.fecha).getTime());
    });
  });
  readonly paginasActividad = computed(() =>
    Math.max(1, Math.ceil(this.actividadFiltrada().length / this.actividadPorPagina)),
  );
  readonly historialVisible = computed(() => {
    const page = Math.min(this.paginaActividad(), this.paginasActividad());
    const start = (page - 1) * this.actividadPorPagina;
    return this.actividadFiltrada().slice(start, start + this.actividadPorPagina);
  });
  readonly inventarioVacio = computed(() =>
    [
      this.inventoryService.pisos(),
      this.inventoryService.areas(),
      this.inventoryService.stock(),
      this.inventoryService.puestos(),
      this.inventoryService.equiposRed(),
      this.inventoryService.componentesRetirados(),
      this.inventoryService.historial(),
    ].every((coleccion) => coleccion.length === 0),
  );

  // Filtros parque
  readonly vistaParque = signal<'TARJETAS' | 'LISTA'>('TARJETAS');
  pisoSeleccionadoId = signal<string>('TODOS');
  areaSeleccionadaId = signal<string>('TODAS');
  busquedaParque = signal('');
  tipoComponenteParque = signal('');
  ordenParque = signal<'PUESTO' | 'USUARIO' | 'COMPONENTES'>('PUESTO');
  paginaParque = signal(1);
  readonly parquePorPagina = 25;

  // Formularios
  nuevoPiso = { nombre: '', nivel: 0 };
  nuevaArea = { nombre: '' };
  readonly pisoSeleccionadoEdificio = signal('');
  readonly areasDelPisoEdificio = computed(() => {
    const pisoId = this.pisoSeleccionadoEdificio();
    return pisoId ? this.areas().filter((area) => area.pisoId === pisoId) : [];
  });

  nuevoStock = {
    tipo: 'DISCO_SSD' as TipoPeriferico,
    marca: '',
    especificacion: '',
    cantidadDisponible: 1,
    stockMinimo: 2,
  };

  nuevoPuesto = {
    areaId: '',
    nombrePuesto: '',
    usuarioAsignado: '',
  };
  readonly pisoSeleccionadoFormPuesto = signal('');
  readonly areasFormPuesto = computed(() => {
    const pisoId = this.pisoSeleccionadoFormPuesto();
    return pisoId ? this.areas().filter((area) => area.pisoId === pisoId) : [];
  });

  nuevoEquipoRed: {
    tipo: TipoEquipoRed;
    marca: string;
    modelo: string;
    areaId: string;
  } = {
    tipo: 'SWITCH',
    marca: '',
    modelo: '',
    areaId: '',
  };
  readonly pisoSeleccionadoFormEquipoRed = signal('');
  readonly areasFormEquipoRed = computed(() => {
    const pisoId = this.pisoSeleccionadoFormEquipoRed();
    return pisoId ? this.areas().filter((area) => area.pisoId === pisoId) : [];
  });

  readonly tiposEquipoRed: TipoEquipoRed[] = ['SWITCH', 'ROUTER', 'AP'];
  readonly estadosComponente: EstadoComponenteRetirado[] = ['REPARACION', 'SCRAP'];
  readonly puestoFichaId = signal<string | null>(null);
  readonly puestoFicha = computed(
    () => this.puestos().find((puesto) => puesto.id === this.puestoFichaId()) ?? null,
  );
  readonly movimientosPuestoFicha = computed(() => {
    const puestoId = this.puestoFichaId();
    return puestoId
      ? this.historial().filter((movimiento) => movimiento.puestoId === puestoId)
      : [];
  });
  readonly tiposPerifericosExternos: TipoPeriferico[] = [
    'MONITOR',
    'TECLADO',
    'MOUSE',
    'SCANNER',
    'IMPRESORA',
  ];
  readonly tiposComponentesPuesto: TipoPeriferico[] = [
    'MONITOR',
    'TECLADO',
    'MOUSE',
    'IMPRESORA',
    'SCANNER',
    'PROCESADOR',
    'RAM',
    'ALMACENAMIENTO',
    'GABINETE',
  ];
  readonly tiposPerifericosCompletos: TipoPeriferico[] = [
    'PROCESADOR',
    'RAM',
    'DISCO_HDD',
    'DISCO_SSD',
    'ALMACENAMIENTO',
    'GABINETE',
    'MONITOR',
    'TECLADO',
    'MOUSE',
    'SCANNER',
    'IMPRESORA',
    'OTRO',
  ];
  readonly puestoEtiquetasId = signal<string | null>(null);
  readonly puestoEtiquetas = computed(
    () => this.puestos().find((puesto) => puesto.id === this.puestoEtiquetasId()) ?? null,
  );
  readonly componentesEtiquetas = computed(
    () =>
      this.puestoEtiquetas()?.componentes.filter(
        (componente) =>
          this.tiposPerifericosExternos.includes(componente.tipo) && !!componente.codigoSeguimiento,
      ) ?? [],
  );
  readonly codigoQrPuesto = signal('');
  readonly errorEtiquetas = signal('');

  @ViewChild('qrImage') private qrImage?: ElementRef<HTMLImageElement>;
  @ViewChildren('barcodeSvg') private barcodeSvgs!: QueryList<ElementRef<SVGSVGElement>>;

  tiposPerifericos: TipoPeriferico[] = [
    'PROCESADOR',
    'RAM',
    'DISCO_HDD',
    'DISCO_SSD',
    'MONITOR',
    'TECLADO',
    'MOUSE',
    'SCANNER',
    'IMPRESORA',
    'OTRO',
  ];

  // Filtros dinámicos
  areasFiltradas = computed(() => {
    const pisoId = this.pisoSeleccionadoId();
    if (pisoId === 'TODOS') return this.areas();
    return this.areas().filter((a) => a.pisoId === pisoId);
  });

  puestosFiltrados = computed(() => {
    let resultado = this.puestos();
    const pisoId = this.pisoSeleccionadoId();
    const areaId = this.areaSeleccionadaId();

    if (pisoId !== 'TODOS') {
      const idsAreasDelPiso = this.areas()
        .filter((a) => a.pisoId === pisoId)
        .map((a) => a.id);
      resultado = resultado.filter((p) => idsAreasDelPiso.includes(p.areaId));
    }

    if (areaId !== 'TODAS') {
      resultado = resultado.filter((p) => p.areaId === areaId);
    }

    const componentType = this.tipoComponenteParque();
    if (componentType) {
      resultado = resultado.filter((puesto) =>
        puesto.componentes.some((componente) => componente.tipo === componentType),
      );
    }
    const consulta = this.normalizarBusqueda(this.busquedaParque());
    if (consulta) {
      resultado = resultado.filter(
        (puesto) =>
          this.normalizarBusqueda(
            [puesto.nombrePuesto, puesto.codigoSeguimiento, puesto.usuarioAsignado].join(' '),
          ).includes(consulta) ||
          this.normalizarBusqueda(puesto.usuarioAsignado).includes(consulta) ||
          puesto.componentes.some(
            (componente) =>
              this.normalizarBusqueda(componente.tipo).includes(consulta) ||
              this.normalizarBusqueda(componente.marca).includes(consulta) ||
              this.normalizarBusqueda(componente.modelo ?? '').includes(consulta) ||
              this.normalizarBusqueda(componente.numeroSerie ?? '').includes(consulta) ||
              this.normalizarBusqueda(componente.especificacion).includes(consulta) ||
              this.normalizarBusqueda(componente.codigoSeguimiento ?? '').includes(consulta),
          ),
      );
    }

    return [...resultado].sort((left, right) => {
      if (this.ordenParque() === 'USUARIO') {
        return left.usuarioAsignado.localeCompare(right.usuarioAsignado, 'es');
      }
      if (this.ordenParque() === 'COMPONENTES') {
        return right.componentes.length - left.componentes.length ||
          left.nombrePuesto.localeCompare(right.nombrePuesto, 'es');
      }
      return left.nombrePuesto.localeCompare(right.nombrePuesto, 'es');
    });
  });
  readonly paginasParque = computed(() =>
    Math.max(1, Math.ceil(this.puestosFiltrados().length / this.parquePorPagina)),
  );
  readonly puestosPaginados = computed(() => {
    const page = Math.min(this.paginaParque(), this.paginasParque());
    const start = (page - 1) * this.parquePorPagina;
    return this.puestosFiltrados().slice(start, start + this.parquePorPagina);
  });
  readonly componentesStockBajo = computed(
    () => this.stock().filter((insumo) => insumo.cantidadDisponible <= insumo.stockMinimo).length,
  );

  limpiarFiltrosStock(): void {
    this.busquedaStock.set('');
    this.tipoStockFiltro.set('');
    this.estadoStockFiltro.set('TODOS');
    this.ordenStock.set('NOMBRE');
    this.paginaStock.set(1);
  }

  limpiarFiltrosParque(): void {
    this.pisoSeleccionadoId.set('TODOS');
    this.areaSeleccionadaId.set('TODAS');
    this.busquedaParque.set('');
    this.tipoComponenteParque.set('');
    this.ordenParque.set('PUESTO');
    this.paginaParque.set(1);
  }

  limpiarFiltrosRed(): void {
    this.busquedaRed.set('');
    this.tipoRedFiltro.set('');
    this.areaRedFiltro.set('TODAS');
    this.ordenRed.set('MARCA');
    this.paginaRed.set(1);
  }

  limpiarFiltrosActividad(): void {
    this.busquedaActividad.set('');
    this.tipoActividadFiltro.set('');
    this.operadorActividadFiltro.set('');
    this.sedeActividadFiltro.set('TODAS');
    this.desdeActividad.set('');
    this.hastaActividad.set('');
    this.ordenActividad.set('NEWEST');
    this.paginaActividad.set(1);
  }

  // Métodos auxiliares
  private normalizarBusqueda(valor: string): string {
    return valor
      .trim()
      .toLocaleLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  obtenerNombreAreaPiso(areaId: string): string {
    const area = this.areas().find((a) => a.id === areaId);
    if (!area) return 'Área no asignada';
    const piso = this.pisos().find((p) => p.id === area.pisoId);
    return `${area.nombre} — (${piso ? piso.nombre : 'Sin piso'})`;
  }

  obtenerNombrePiso(pisoId: string): string {
    const piso = this.pisos().find((p) => p.id === pisoId);
    return piso ? piso.nombre : 'Desconocido';
  }

  obtenerNombreArea(areaId: string): string {
    return this.areas().find((area) => area.id === areaId)?.nombre ?? 'Área no asignada';
  }

  obtenerPuestoNombre(puestoId: string): string {
    return this.puestos().find((puesto) => puesto.id === puestoId)?.nombrePuesto ?? puestoId;
  }

  verFicha(puestoId: string): void {
    this.puestoFichaId.set(puestoId);
  }

  cerrarFicha(): void {
    this.puestoFichaId.set(null);
  }

  cambiarVista(vista: VistaActiva): void {
    const role = this.authService.user()?.role;
    if (role === 'solicitante' && vista !== 'TICKETS') return;
    if (role === 'dashboard') return;
    if (vista === 'PATRIMONIO' && role !== 'admin' && role !== 'operator') return;
    if (vista === 'AUDITORIA' && role !== 'admin') return;
    this.vistaActiva.set(vista);
    this.menuMovilAbierto.set(false);
    if (vista === 'REPORTES' && this.authService.user()?.role === 'admin') {
      void this.cargarUsuarios();
    }
  }

  private fechaLocalIso(value: Date | string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  cambiarSede(sedeId: string): void {
    if (!this.sedes().some((sede) => sede.id === sedeId)) return;
    this.sedeSeleccionadaId.set(sedeId);
    this.pisoSeleccionadoId.set('TODOS');
    this.areaSeleccionadaId.set('TODAS');
    this.paginaParque.set(1);
    this.paginaStock.set(1);
    this.paginaRed.set(1);
    this.pisoSeleccionadoEdificio.set('');
    this.pisoSeleccionadoFormPuesto.set('');
    this.pisoSeleccionadoFormEquipoRed.set('');
  }

  async crearSede(): Promise<void> {
    if (this.creandoSede()) return;
    const sede = this.nuevaSede();
    if (!sede.nombre.trim()) {
      this.errorSedes.set('Ingresá el nombre de la delegación.');
      return;
    }
    const resumen = [
      `Delegación: ${sede.nombre.trim()}`,
      `Departamento: ${sede.departamento.trim() || 'Sin departamento'}`,
      `Localidad: ${sede.localidad.trim() || 'Sin localidad'}`,
      `Dirección: ${sede.direccion.trim() || 'Sin dirección'}`,
    ].join('\n');
    if (!window.confirm(`¿Confirmás crear esta sede?\n\n${resumen}`)) return;
    this.errorSedes.set('');
    this.creandoSede.set(true);
    try {
      const creada = await this.locationsService.crear({
        nombre: sede.nombre.trim(),
        departamento: sede.departamento.trim(),
        localidad: sede.localidad.trim(),
        direccion: sede.direccion.trim(),
      });
      this.nuevaSede.set({ nombre: '', departamento: '', localidad: '', direccion: '' });
      this.cambiarSede(creada.id);
      this.mostrarToast(
        `Se creó la sede ${creada.nombre}. Ahora podés cargar su piso y sus áreas.`,
      );
    } catch (error: unknown) {
      this.errorSedes.set(error instanceof Error ? error.message : 'No se pudo crear la sede.');
    } finally {
      this.creandoSede.set(false);
    }
  }

  iniciarEdicionSede(sede: Sede): void {
    if (this.authService.user()?.role !== 'admin') return;
    this.sedeEnEdicionId.set(sede.id);
    this.sedeEdicion.set({
      nombre: sede.nombre,
      departamento: sede.departamento,
      localidad: sede.localidad,
      direccion: sede.direccion,
    });
    this.errorEdicionSede.set('');
  }

  actualizarCampoSede(campo: keyof NewLocation, valor: string): void {
    this.sedeEdicion.update((sede) => ({ ...sede, [campo]: valor }));
  }

  cancelarEdicionSede(): void {
    if (this.actualizandoSede()) return;
    this.sedeEnEdicionId.set(null);
    this.errorEdicionSede.set('');
  }

  async guardarEdicionSede(): Promise<void> {
    const id = this.sedeEnEdicionId();
    const sede = this.sedeEdicion();
    if (!id || this.actualizandoSede() || this.authService.user()?.role !== 'admin') return;
    if (!sede.nombre.trim() || sede.nombre.trim().length > 120) {
      this.errorEdicionSede.set('Ingresá un nombre de sede válido de hasta 120 caracteres.');
      return;
    }
    const anterior = this.sedes().find((item) => item.id === id);
    const cambios = [
      `Nombre: ${anterior?.nombre ?? '—'} → ${sede.nombre.trim()}`,
      `Departamento: ${anterior?.departamento || 'Sin departamento'} → ${sede.departamento.trim() || 'Sin departamento'}`,
      `Localidad: ${anterior?.localidad || 'Sin localidad'} → ${sede.localidad.trim() || 'Sin localidad'}`,
      `Dirección: ${anterior?.direccion || 'Sin dirección'} → ${sede.direccion.trim() || 'Sin dirección'}`,
    ].join('\n');
    if (!window.confirm(`¿Confirmás modificar la sede?\n\n${cambios}`)) return;
    this.actualizandoSede.set(true);
    this.errorEdicionSede.set('');
    try {
      await this.locationsService.actualizar(id, {
        nombre: sede.nombre.trim(),
        departamento: sede.departamento.trim(),
        localidad: sede.localidad.trim(),
        direccion: sede.direccion.trim(),
      });
      this.sedeEnEdicionId.set(null);
      this.mostrarToast('Se actualizaron los datos de la sede.');
    } catch (error: unknown) {
      this.errorEdicionSede.set(
        error instanceof Error ? error.message : 'No se pudo actualizar la sede.',
      );
    } finally {
      this.actualizandoSede.set(false);
    }
  }

  actualizarNuevaSede(campo: keyof NewLocation, valor: string): void {
    this.nuevaSede.update((actual) => ({ ...actual, [campo]: valor }));
  }

  private async cargarUsuarios(): Promise<void> {
    try {
      await Promise.all([this.authService.cargarUsuarios(), this.authService.cargarAreas()]);
    } catch (error: unknown) {
      this.mostrarToast(
        error instanceof Error ? error.message : 'No se pudieron cargar los usuarios.',
        'error',
      );
    }
  }

  async crearUsuario(): Promise<void> {
    const usuario = this.nuevoUsuario();
    if (usuario.username.trim().length < 3 || usuario.password.length < 12) {
      this.mostrarToast('El usuario debe tener al menos 3 caracteres y la contraseña 12.', 'error');
      return;
    }
    try {
      await this.authService.crearUsuario(
        usuario.username.trim(),
        usuario.password,
        usuario.role,
        usuario.role === 'solicitante' ? usuario.areaId || null : null,
      );
      this.nuevoUsuario.set({ username: '', password: '', role: 'operator', areaId: '' });
      this.mostrarToast('Se creó la cuenta de usuario.');
    } catch (error: unknown) {
      this.mostrarToast(
        error instanceof Error ? error.message : 'No se pudo crear el usuario.',
        'error',
      );
    }
  }

  async restablecerContrasena(usuarioId: string): Promise<void> {
    const password = this.nuevaContrasena();
    if (password.length < 12) {
      this.mostrarToast('La nueva contraseña debe tener al menos 12 caracteres.', 'error');
      return;
    }

    this.usuarioRestableciendo.set(usuarioId);
    try {
      await this.authService.restablecerContrasena(usuarioId, password);
      this.usuarioParaRestablecer.set(null);
      this.nuevaContrasena.set('');
      this.mostrarToast('Se restableció la contraseña y se cerraron las otras sesiones.');
    } catch (error: unknown) {
      this.mostrarToast(
        error instanceof Error ? error.message : 'No se pudo restablecer la contraseña.',
        'error',
      );
    } finally {
      this.usuarioRestableciendo.set(null);
    }
  }

  iniciarEdicionUsuario(usuario: ManagedUser): void {
    this.usuarioEnEdicion.set(usuario.id);
    this.usuarioEdicion.set({ role: usuario.role, areaId: usuario.areaId ?? '' });
    this.usuarioParaRestablecer.set(null);
    this.nuevaContrasena.set('');
  }

  actualizarEdicionUsuario(campo: 'role' | 'areaId', valor: string): void {
    if (campo === 'areaId') {
      this.usuarioEdicion.update((usuario) => ({ ...usuario, areaId: valor }));
      return;
    }
    if (
      valor !== 'admin' &&
      valor !== 'operator' &&
      valor !== 'solicitante' &&
      valor !== 'dashboard'
    ) {
      return;
    }
    this.usuarioEdicion.update((usuario) => ({
      role: valor,
      areaId: valor === 'solicitante' ? usuario.areaId : '',
    }));
  }

  cancelarEdicionUsuario(): void {
    this.usuarioEnEdicion.set(null);
  }

  async guardarEdicionUsuario(usuarioId: string): Promise<void> {
    if (this.usuarioEnEdicion() !== usuarioId) return;
    const edicion = this.usuarioEdicion();
    if (edicion.role === 'solicitante' && !edicion.areaId) {
      this.mostrarToast('Seleccioná un área para la cuenta solicitante.', 'error');
      return;
    }

    this.usuarioActualizando.set(usuarioId);
    try {
      await this.authService.actualizarUsuario(
        usuarioId,
        edicion.role,
        edicion.role === 'solicitante' ? edicion.areaId : null,
      );
      this.usuarioEnEdicion.set(null);
      this.mostrarToast('Se actualizaron los permisos y el área del usuario.');
    } catch (error: unknown) {
      this.mostrarToast(
        error instanceof Error ? error.message : 'No se pudo actualizar el usuario.',
        'error',
      );
    } finally {
      this.usuarioActualizando.set(null);
    }
  }

  actualizarNuevoUsuario(campo: 'username' | 'password' | 'role' | 'areaId', valor: string): void {
    if (
      campo === 'role' &&
      valor !== 'admin' &&
      valor !== 'operator' &&
      valor !== 'solicitante' &&
      valor !== 'dashboard'
    ) {
      return;
    }
    this.nuevoUsuario.update((usuario) => ({ ...usuario, [campo]: valor }));
  }

  nombreRol(role: SystemRole): string {
    const names: Record<SystemRole, string> = {
      admin: 'Administrador',
      operator: 'Operador',
      solicitante: 'Solicitante',
      dashboard: 'Dashboard (solo lectura)',
    };
    return names[role];
  }

  alternarMenuMovil(): void {
    this.menuMovilAbierto.update((abierto) => !abierto);
  }

  ngOnDestroy(): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
  }

  abrirModal(modal: Exclude<ModalActivo, null>): void {
    this.errorFormulario.set('');
    if (modal === 'NUEVO_COMPONENTE') {
      this.nuevoComponenteManual.set({
        tipo: 'MONITOR',
        marca: '',
        modelo: '',
        caracteristicas: '',
      });
    } else if (modal === 'NUEVO_PUESTO') {
      this.nuevoPuesto.areaId = '';
      this.pisoSeleccionadoFormPuesto.set('');
    } else if (modal === 'NUEVO_EQUIPO_RED') {
      this.nuevoEquipoRed.areaId = '';
      this.pisoSeleccionadoFormEquipoRed.set('');
    } else if (modal === 'NUEVA_AREA') {
      this.nuevaArea.nombre = '';
    } else if (modal === 'NUEVO_PISO') {
      this.nuevoPiso.nombre = '';
    } else if (modal === 'NUEVO_STOCK') {
      this.nuevoStock.marca = '';
      this.nuevoStock.especificacion = '';
      this.nuevoStock.cantidadDisponible = 1;
    } else if (modal === 'SALDO_INICIAL') {
      this.nuevoStock.marca = '';
      this.nuevoStock.especificacion = '';
      this.nuevoStock.cantidadDisponible = 0;
    } else if (modal === 'AJUSTE_STOCK') {
      this.motivoAjuste.set('');
    }
    this.modalActivo.set(modal);
  }

  cerrarModal(): void {
    if (this.guardandoModal()) return;
    if (this.modalActivo() === 'NUEVO_COMPONENTE') {
      this.puestoComponenteId.set(null);
    }
    this.modalActivo.set(null);
    this.errorFormulario.set('');
  }

  abrirReemplazo(puestoId: string): void {
    const puesto = this.puestos().find((item) => item.id === puestoId);
    if (!puesto || puesto.componentes.length === 0) {
      this.mostrarToast('El puesto no tiene componentes registrados para reemplazar.', 'error');
      return;
    }
    this.reemplazoPuestoId.set(puestoId);
    this.reemplazoComponenteId.set('');
    this.reemplazoStockId.set('');
    this.reemplazoStockBusqueda.set('');
    this.reemplazoMotivoTipo.set('Falla');
    this.reemplazoMotivoDetalle.set('');
    this.reemplazoConfirmado.set(false);
    this.reemplazoError.set('');
    this.reemplazoModalAbierto.set(true);
  }

  cerrarReemplazo(): void {
    if (this.reemplazoGuardando()) return;
    this.reemplazoModalAbierto.set(false);
    this.reemplazoPuestoId.set('');
    this.reemplazoComponenteId.set('');
    this.reemplazoStockId.set('');
    this.reemplazoStockBusqueda.set('');
    this.reemplazoMotivoDetalle.set('');
    this.reemplazoConfirmado.set(false);
    this.reemplazoError.set('');
  }

  seleccionarStockReemplazo(value: string): void {
    this.reemplazoStockBusqueda.set(value);
    const option = this.opcionesStockReemplazo().find((item) => item.label === value);
    this.reemplazoStockId.set(option?.id ?? '');
    this.reemplazoConfirmado.set(false);
    this.reemplazoError.set('');
  }

  actualizarConfirmacionReemplazo(event: Event): void {
    const checkbox = event.target;
    if (checkbox instanceof HTMLInputElement) {
      this.reemplazoConfirmado.set(checkbox.checked);
      this.reemplazoError.set('');
    }
  }

  etiquetaStockReemplazo(insumo: StockInsumo, index: number): string {
    return `${insumo.marca} · ${insumo.especificacion} · ${insumo.tipo} · ${insumo.cantidadDisponible} disponibles · opción ${index + 1}`;
  }

  abrirModalComponente(puestoId: string): void {
    this.puestoComponenteId.set(puestoId);
    this.abrirModal('NUEVO_COMPONENTE');
  }

  actualizarTipoComponenteManual(tipo: TipoPeriferico): void {
    this.nuevoComponenteManual.update((componente) => ({ ...componente, tipo }));
  }

  actualizarCampoComponenteManual(
    campo: 'marca' | 'modelo' | 'caracteristicas',
    valor: string,
  ): void {
    this.nuevoComponenteManual.update((componente) => ({ ...componente, [campo]: valor }));
  }

  async guardarComponenteManual(): Promise<void> {
    if (this.guardandoModal()) return;
    const puestoId = this.puestoComponenteId();
    const componente = this.nuevoComponenteManual();
    const marca = componente.marca.trim();
    const modelo = componente.modelo.trim();
    const caracteristicas = componente.caracteristicas.trim();
    if (!puestoId || !marca || !modelo || !caracteristicas) {
      this.errorFormulario.set('Completá marca, modelo y características del componente.');
      return;
    }
    const puesto = this.puestos().find((item) => item.id === puestoId);
    if (
      !window.confirm(
        `¿Confirmás registrar este componente?\n\nPuesto: ${puesto?.nombrePuesto ?? puestoId}\nComponente: ${componente.tipo} · ${marca} ${modelo}\nCaracterísticas: ${caracteristicas}`,
      )
    ) {
      return;
    }

    this.guardandoModal.set(true);
    try {
      const componenteGuardado = this.inventoryService.agregarComponenteManual(puestoId, {
        tipo: componente.tipo,
        marca,
        modelo,
        especificacion: caracteristicas,
      });
      await this.inventoryService.guardarEnServidor();
      this.guardandoModal.set(false);
      this.cerrarModal();
      this.mostrarToast(
        this.tiposPerifericosExternos.includes(componenteGuardado.tipo)
          ? `Componente relevado. Código asignado: ${componenteGuardado.codigoSeguimiento}.`
          : 'Componente relevado correctamente.',
      );
    } catch (error: unknown) {
      this.errorFormulario.set(
        error instanceof Error ? error.message : 'No se pudo agregar el componente.',
      );
    } finally {
      this.guardandoModal.set(false);
    }
  }

  abrirEdicionComponente(puestoId: string, componente: ComponentePuesto): void {
    if (this.authService.user()?.role !== 'admin') {
      this.mostrarToast('Solo una persona administradora puede editar componentes.', 'error');
      return;
    }
    this.componenteEnEdicion.set({
      puestoId,
      id: componente.id,
      tipo: componente.tipo,
      marca: componente.marca,
      modelo: componente.modelo ?? '',
      especificacion: componente.especificacion,
      numeroSerie: componente.numeroSerie ?? '',
      codigoSeguimiento: componente.codigoSeguimiento ?? '',
      motivo: '',
    });
    this.errorEdicionComponente.set('');
  }

  actualizarCampoEdicionComponente(
    campo: 'marca' | 'modelo' | 'especificacion' | 'numeroSerie' | 'codigoSeguimiento' | 'motivo',
    valor: string,
  ): void {
    this.componenteEnEdicion.update((componente) =>
      componente ? { ...componente, [campo]: valor } : null,
    );
    this.errorEdicionComponente.set('');
  }

  actualizarTipoEdicionComponente(tipo: TipoPeriferico): void {
    if (!this.tiposPerifericosCompletos.includes(tipo)) return;
    this.componenteEnEdicion.update((componente) => (componente ? { ...componente, tipo } : null));
    this.errorEdicionComponente.set('');
  }

  cerrarEdicionComponente(): void {
    if (this.guardandoEdicionComponente()) return;
    this.componenteEnEdicion.set(null);
    this.errorEdicionComponente.set('');
  }

  async guardarEdicionComponente(): Promise<void> {
    const componente = this.componenteEnEdicion();
    if (
      !componente ||
      this.guardandoEdicionComponente() ||
      this.authService.user()?.role !== 'admin'
    ) return;

    const marca = componente.marca.trim();
    const modelo = componente.modelo.trim();
    const especificacion = componente.especificacion.trim();
    const numeroSerie = componente.numeroSerie.trim();
    const codigoSeguimiento = componente.codigoSeguimiento.trim();
    const motivo = componente.motivo.trim();
    if (!marca || !especificacion || !motivo) {
      this.errorEdicionComponente.set('Completá marca, especificación y motivo de la corrección.');
      return;
    }

    const cambios: ComponentEdit = {
      tipo: componente.tipo,
      marca,
      ...(modelo ? { modelo } : {}),
      especificacion,
      ...(numeroSerie ? { numeroSerie } : {}),
      ...(codigoSeguimiento ? { codigoSeguimiento } : {}),
    };
    const anterior = this.puestos()
      .find((puesto) => puesto.id === componente.puestoId)
      ?.componentes.find((item) => item.id === componente.id);
    const nombrePuesto =
      this.puestos().find((puesto) => puesto.id === componente.puestoId)?.nombrePuesto ??
      componente.puestoId;
    const resumen = [
      `Puesto: ${nombrePuesto}`,
      `Tipo: ${anterior?.tipo ?? '—'} → ${cambios.tipo}`,
      `Marca: ${anterior?.marca ?? '—'} → ${cambios.marca}`,
      `Modelo: ${anterior?.modelo ?? '—'} → ${cambios.modelo ?? 'Sin modelo'}`,
      `Especificación: ${anterior?.especificacion ?? '—'} → ${cambios.especificacion}`,
      `Motivo: ${motivo}`,
    ].join('\n');
    if (!window.confirm(`¿Confirmás corregir los datos del componente?\n\n${resumen}`)) return;
    this.guardandoEdicionComponente.set(true);
    this.errorEdicionComponente.set('');
    try {
      await this.inventoryService.editarComponenteAdministrativamente(
        componente.puestoId,
        componente.id,
        cambios,
        motivo,
      );
      this.componenteEnEdicion.set(null);
      this.mostrarToast('Se corrigieron los datos del componente y se registró la auditoría.');
    } catch (error: unknown) {
      this.errorEdicionComponente.set(
        error instanceof Error ? error.message : 'No se pudo actualizar el componente.',
      );
    } finally {
      this.guardandoEdicionComponente.set(false);
    }
  }

  abrirEdicionPuesto(puesto: PuestoTrabajo): void {
    if (!this.puedeEditarInventario()) return;
    this.registroEnEdicion.set({
      tipo: 'PUESTO',
      id: puesto.id,
      nombrePuesto: puesto.nombrePuesto,
      usuarioAsignado: puesto.usuarioAsignado,
      tipoStock: 'DISCO_SSD',
      marca: '',
      especificacion: '',
      stockMinimo: 0,
      tipoRed: 'SWITCH',
      modelo: '',
      nombreArea: '',
      nombrePiso: '',
      nivelPiso: 0,
    });
  }

  abrirEdicionStock(insumo: StockInsumo): void {
    if (!this.puedeEditarInventario()) return;
    this.registroEnEdicion.set({
      tipo: 'STOCK',
      id: insumo.id,
      nombrePuesto: '',
      usuarioAsignado: '',
      tipoStock: insumo.tipo,
      marca: insumo.marca,
      especificacion: insumo.especificacion,
      stockMinimo: insumo.stockMinimo,
      tipoRed: 'SWITCH',
      modelo: '',
      nombreArea: '',
      nombrePiso: '',
      nivelPiso: 0,
    });
  }

  abrirEdicionEquipoRed(equipo: EquipoRed): void {
    if (!this.puedeEditarInventario()) return;
    this.registroEnEdicion.set({
      tipo: 'RED',
      id: equipo.id,
      nombrePuesto: '',
      usuarioAsignado: '',
      tipoStock: 'DISCO_SSD',
      marca: equipo.marca,
      especificacion: '',
      stockMinimo: 0,
      tipoRed: equipo.tipo,
      modelo: equipo.modelo,
      nombreArea: '',
      nombrePiso: '',
      nivelPiso: 0,
    });
  }

  abrirEdicionArea(areaId: string): void {
    if (!this.puedeEditarInventario()) return;
    const area = this.inventoryService.areas().find((item) => item.id === areaId);
    if (!area) return;
    this.registroEnEdicion.set({
      tipo: 'AREA',
      id: area.id,
      nombrePuesto: '',
      usuarioAsignado: '',
      tipoStock: 'DISCO_SSD',
      marca: '',
      especificacion: '',
      stockMinimo: 0,
      tipoRed: 'SWITCH',
      modelo: '',
      nombreArea: area.nombre,
      nombrePiso: '',
      nivelPiso: 0,
    });
  }

  abrirEdicionPiso(pisoId: string): void {
    if (!this.puedeEditarInventario()) return;
    const piso = this.inventoryService.pisos().find((item) => item.id === pisoId);
    if (!piso) return;
    this.registroEnEdicion.set({
      tipo: 'PISO',
      id: piso.id,
      nombrePuesto: '',
      usuarioAsignado: '',
      tipoStock: 'DISCO_SSD',
      marca: '',
      especificacion: '',
      stockMinimo: 0,
      tipoRed: 'SWITCH',
      modelo: '',
      nombreArea: '',
      nombrePiso: piso.nombre,
      nivelPiso: piso.nivel,
    });
  }

  actualizarEdicionPuesto(campo: 'nombrePuesto' | 'usuarioAsignado', valor: string): void {
    this.registroEnEdicion.update((editor) =>
      editor?.tipo === 'PUESTO' ? { ...editor, [campo]: valor } : editor,
    );
  }

  actualizarEdicionStock(
    campo: 'tipoStock' | 'marca' | 'especificacion' | 'stockMinimo',
    valor: string | number,
  ): void {
    this.registroEnEdicion.update((editor) => {
      if (editor?.tipo !== 'STOCK') return editor;
      if (campo === 'tipoStock') {
        const tipo = this.tiposPerifericosCompletos.find((item) => item === valor);
        return tipo ? { ...editor, tipoStock: tipo } : editor;
      }
      if (campo === 'stockMinimo') {
        const stockMinimo = typeof valor === 'number' ? valor : Number(valor);
        return { ...editor, stockMinimo };
      }
      if (campo === 'marca') return { ...editor, marca: String(valor) };
      return { ...editor, especificacion: String(valor) };
    });
  }

  actualizarEdicionEquipoRed(campo: 'tipoRed' | 'marca' | 'modelo', valor: string): void {
    this.registroEnEdicion.update((editor) => {
      if (editor?.tipo !== 'RED') return editor;
      if (campo === 'tipoRed') {
        const tipo = this.tiposEquipoRed.find((item) => item === valor);
        return tipo ? { ...editor, tipoRed: tipo } : editor;
      }
      return { ...editor, [campo]: valor };
    });
  }

  actualizarEdicionArea(nombreArea: string): void {
    this.registroEnEdicion.update((editor) =>
      editor?.tipo === 'AREA' ? { ...editor, nombreArea } : editor,
    );
  }

  actualizarEdicionPiso(campo: 'nombrePiso' | 'nivelPiso', valor: string | number): void {
    this.registroEnEdicion.update((editor) => {
      if (editor?.tipo !== 'PISO') return editor;
      if (campo === 'nombrePiso') return { ...editor, nombrePiso: String(valor) };
      return { ...editor, nivelPiso: typeof valor === 'number' ? valor : Number(valor) };
    });
  }

  cancelarEdicionInventario(): void {
    if (this.guardandoEdicionInventario()) return;
    this.registroEnEdicion.set(null);
  }

  private resumenCambiosInventario(editor: EditorRegistroInventario): string {
    switch (editor.tipo) {
      case 'PUESTO': {
        const actual = this.puestos().find((item) => item.id === editor.id);
        return [
          `Puesto: ${actual?.nombrePuesto ?? '—'} → ${editor.nombrePuesto.trim()}`,
          `Usuario asignado: ${actual?.usuarioAsignado ?? '—'} → ${editor.usuarioAsignado.trim()}`,
        ].join('\n');
      }
      case 'STOCK': {
        const actual = this.stock().find((item) => item.id === editor.id);
        return [
          `Producto: ${actual?.marca ?? '—'} ${actual?.especificacion ?? ''} → ${editor.marca.trim()} ${editor.especificacion.trim()}`,
          `Tipo: ${actual?.tipo ?? '—'} → ${editor.tipoStock}`,
          `Stock mínimo: ${actual?.stockMinimo ?? '—'} → ${editor.stockMinimo}`,
          'El saldo actual y el historial de movimientos no se modificarán.',
        ].join('\n');
      }
      case 'RED': {
        const actual = this.equiposRed().find((item) => item.id === editor.id);
        return [
          `Tipo: ${actual?.tipo ?? '—'} → ${editor.tipoRed}`,
          `Marca: ${actual?.marca ?? '—'} → ${editor.marca.trim()}`,
          `Modelo: ${actual?.modelo ?? '—'} → ${editor.modelo.trim()}`,
        ].join('\n');
      }
      case 'AREA': {
        const actual = this.areas().find((item) => item.id === editor.id);
        return `Área: ${actual?.nombre ?? '—'} → ${editor.nombreArea.trim()}`;
      }
      case 'PISO': {
        const actual = this.pisos().find((item) => item.id === editor.id);
        return [
          `Piso: ${actual?.nombre ?? '—'} → ${editor.nombrePiso.trim()}`,
          `Nivel: ${actual?.nivel ?? '—'} → ${editor.nivelPiso}`,
        ].join('\n');
      }
    }
  }

  async guardarEdicionInventario(): Promise<void> {
    const editor = this.registroEnEdicion();
    if (!editor || this.guardandoEdicionInventario() || !this.puedeEditarInventario()) return;
    const nombres: Record<EditorRegistroInventario['tipo'], string> = {
      PUESTO: editor.nombrePuesto,
      STOCK: editor.marca,
      RED: `${editor.marca} ${editor.modelo}`,
      AREA: editor.nombreArea,
      PISO: editor.nombrePiso,
    };
    if (
      !window.confirm(
        `¿Confirmás modificar ${nombres[editor.tipo]}?\n\n${this.resumenCambiosInventario(editor)}`,
      )
    ) return;
    this.guardandoEdicionInventario.set(true);
    try {
      switch (editor.tipo) {
        case 'PUESTO':
          this.inventoryService.editarPuestoTrabajo(editor.id, {
            nombrePuesto: editor.nombrePuesto,
            usuarioAsignado: editor.usuarioAsignado,
          });
          break;
        case 'STOCK':
          this.inventoryService.editarProductoStock(editor.id, {
            tipo: editor.tipoStock,
            marca: editor.marca,
            especificacion: editor.especificacion,
            stockMinimo: editor.stockMinimo,
          });
          break;
        case 'RED':
          this.inventoryService.editarEquipoRed(editor.id, {
            tipo: editor.tipoRed,
            marca: editor.marca,
            modelo: editor.modelo,
          });
          break;
        case 'AREA':
          this.inventoryService.editarArea(editor.id, editor.nombreArea);
          break;
        case 'PISO':
          this.inventoryService.editarPiso(editor.id, {
            nombre: editor.nombrePiso,
            nivel: editor.nivelPiso,
          });
          break;
      }
      await this.inventoryService.guardarEnServidor();
      this.registroEnEdicion.set(null);
      this.mostrarToast('Se guardaron los cambios y quedaron registrados en auditoría.');
    } catch (error: unknown) {
      this.mostrarToast(
        error instanceof Error ? error.message : 'No se pudieron guardar los cambios.',
        'error',
      );
    } finally {
      this.guardandoEdicionInventario.set(false);
    }
  }

  private puedeEditarInventario(): boolean {
    const role = this.authService.user()?.role;
    return role === 'admin' || role === 'operator';
  }

  mostrarToast(mensaje: string, tipo: ToastNotification['tipo'] = 'success'): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toast.set({ mensaje, tipo });
    this.toastTimer = setTimeout(() => this.toast.set(null), 3000);
  }

  cerrarToast(): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = undefined;
    this.toast.set(null);
  }

  solicitarEliminacion(tipo: TipoConfirmacion, id: string, nombre: string): void {
    if (this.eliminandoRegistro()) return;
    this.confirmacionPendiente.set({ tipo, id, nombre });
  }

  cancelarEliminacion(): void {
    if (this.eliminandoRegistro()) return;
    this.confirmacionPendiente.set(null);
  }

  async confirmarEliminacion(): Promise<void> {
    const confirmacion = this.confirmacionPendiente();
    if (!confirmacion || this.eliminandoRegistro()) return;

    this.eliminandoRegistro.set(true);
    try {
      switch (confirmacion.tipo) {
        case 'PUESTO':
          this.inventoryService.eliminarPuestoTrabajo(confirmacion.id);
          break;
        case 'STOCK':
          this.inventoryService.eliminarInsumoStock(confirmacion.id);
          break;
        case 'PISO':
          this.inventoryService.eliminarPiso(confirmacion.id);
          if (this.pisoSeleccionadoEdificio() === confirmacion.id) {
            this.pisoSeleccionadoEdificio.set('');
          }
          if (this.pisoSeleccionadoId() === confirmacion.id) {
            this.pisoSeleccionadoId.set('TODOS');
            this.areaSeleccionadaId.set('TODAS');
          }
          if (this.pisoSeleccionadoFormPuesto() === confirmacion.id) {
            this.cambiarPisoFormularioPuesto('');
          }
          if (this.pisoSeleccionadoFormEquipoRed() === confirmacion.id) {
            this.cambiarPisoFormularioEquipoRed('');
          }
          break;
        case 'AREA':
          this.inventoryService.eliminarArea(confirmacion.id);
          if (this.areaSeleccionadaId() === confirmacion.id) {
            this.areaSeleccionadaId.set('TODAS');
          }
          break;
        case 'RED':
          this.inventoryService.eliminarEquipoRed(confirmacion.id);
          break;
      }
      await this.inventoryService.guardarEnServidor();
      this.mostrarToast(`${confirmacion.nombre} fue eliminado.`);
      this.confirmacionPendiente.set(null);
    } catch (error: unknown) {
      this.mostrarToast(
        error instanceof Error ? error.message : 'No se pudo completar la eliminación.',
        'error',
      );
    } finally {
      this.eliminandoRegistro.set(false);
    }
  }

  // Guardar datos
  async guardarPiso(): Promise<void> {
    if (this.guardandoModal()) return;
    const nombre = this.nuevoPiso.nombre.trim();
    if (!nombre) {
      this.errorFormulario.set('Ingresá el nombre del piso.');
      return;
    }
    const sede = this.sedeSeleccionada()?.nombre ?? 'Sede no identificada';
    if (
      !window.confirm(
        `¿Confirmás crear el piso "${nombre}"?\n\nSede: ${sede}\nNivel: ${this.nuevoPiso.nivel}`,
      )
    ) return;
    this.guardandoModal.set(true);
    try {
      const piso = this.inventoryService.crearPiso(
        nombre,
        this.nuevoPiso.nivel,
        this.sedeSeleccionadaId(),
      );
      await this.inventoryService.guardarEnServidor();
      this.pisoSeleccionadoEdificio.set(piso.id);
      this.nuevoPiso = { nombre: '', nivel: this.nuevoPiso.nivel + 1 };
      this.guardandoModal.set(false);
      this.cerrarModal();
      this.mostrarToast(`Se creó ${piso.nombre}.`);
    } catch (error: unknown) {
      this.errorFormulario.set(
        error instanceof Error ? error.message : 'No se pudo crear el piso.',
      );
    } finally {
      this.guardandoModal.set(false);
    }
  }

  async guardarArea(): Promise<void> {
    if (this.guardandoModal()) return;
    const pisoId = this.pisoSeleccionadoEdificio();
    const nombre = this.nuevaArea.nombre.trim();
    if (!pisoId || !this.pisos().some((piso) => piso.id === pisoId) || !nombre) {
      this.errorFormulario.set('Seleccioná un piso e ingresá el nombre del área.');
      return;
    }
    const piso = this.pisos().find((item) => item.id === pisoId);
    if (
      !window.confirm(
        `¿Confirmás crear el área "${nombre}"?\n\nPiso: ${piso?.nombre ?? pisoId}\nSede: ${this.sedes().find((item) => item.id === piso?.sedeId)?.nombre ?? 'Sede no identificada'}`,
      )
    ) return;
    this.guardandoModal.set(true);
    try {
      this.inventoryService.crearArea(pisoId, nombre);
      await this.inventoryService.guardarEnServidor();
      this.nuevaArea.nombre = '';
      this.guardandoModal.set(false);
      this.cerrarModal();
      this.mostrarToast(`Se creó el área ${nombre}.`);
    } catch (error: unknown) {
      this.errorFormulario.set(
        error instanceof Error ? error.message : 'No se pudo crear el área.',
      );
    } finally {
      this.guardandoModal.set(false);
    }
  }

  async guardarNuevoStock(): Promise<void> {
    if (this.guardandoModal()) return;
    if (this.sedeSeleccionada()?.tipo !== 'CENTRAL') {
      this.errorFormulario.set(
        'Los ingresos de stock se registran en Casa Central y se envían a las delegaciones.',
      );
      return;
    }
    const marca = this.nuevoStock.marca.trim();
    const especificacion = this.nuevoStock.especificacion.trim();
    const cantidad = Number(this.nuevoStock.cantidadDisponible);
    if (!marca || !especificacion || !Number.isInteger(cantidad) || cantidad < 1) {
      this.errorFormulario.set('Ingresá marca, especificación y una cantidad entera mayor a cero.');
      return;
    }
    if (
      !window.confirm(
        `¿Confirmás ingresar este producto al stock?\n\nProducto: ${this.nuevoStock.tipo} · ${marca} · ${especificacion}\nCantidad a ingresar: ${cantidad}\nSede donde se registrará: ${this.sedeSeleccionada()?.nombre ?? 'Casa Central'}\nStock mínimo: ${this.nuevoStock.stockMinimo}`,
      )
    ) return;
    this.guardandoModal.set(true);
    try {
      this.inventoryService.agregarInsumoStock(
        {
          ...this.nuevoStock,
          marca,
          especificacion,
          cantidadDisponible: cantidad,
        },
        this.sedeSeleccionadaId(),
      );
      await this.inventoryService.guardarEnServidor();
      this.nuevoStock.marca = '';
      this.nuevoStock.especificacion = '';
      this.nuevoStock.cantidadDisponible = 1;
      this.guardandoModal.set(false);
      this.cerrarModal();
      this.mostrarToast('El ingreso se agregó al stock.');
    } catch (error: unknown) {
      this.errorFormulario.set(
        error instanceof Error ? error.message : 'No se pudo guardar el stock.',
      );
    } finally {
      this.guardandoModal.set(false);
    }
  }

  async guardarSaldoInicial(): Promise<void> {
    if (this.guardandoModal()) return;
    if (this.sedeSeleccionada()?.tipo !== 'CENTRAL') {
      this.errorFormulario.set(
        'El saldo inicial se registra en Casa Central; las delegaciones reciben stock mediante envíos.',
      );
      return;
    }
    const marca = this.nuevoStock.marca.trim();
    const especificacion = this.nuevoStock.especificacion.trim();
    const cantidad = Number(this.nuevoStock.cantidadDisponible);
    if (
      !marca ||
      !especificacion ||
      !Number.isInteger(cantidad) ||
      cantidad < 0 ||
      !Number.isInteger(this.nuevoStock.stockMinimo) ||
      this.nuevoStock.stockMinimo < 0
    ) {
      this.errorFormulario.set(
        'Ingresá el producto y un saldo y mínimo enteros iguales o mayores que cero.',
      );
      return;
    }
    if (
      !window.confirm(
        `¿Confirmás registrar el saldo inicial?\n\nProducto: ${this.nuevoStock.tipo} · ${marca} · ${especificacion}\nSaldo inicial: ${cantidad}\nSede donde se registrará: ${this.sedeSeleccionada()?.nombre ?? 'Casa Central'}\nStock mínimo: ${this.nuevoStock.stockMinimo}`,
      )
    ) return;
    this.guardandoModal.set(true);
    try {
      this.inventoryService.registrarSaldoInicial(
        { ...this.nuevoStock, marca, especificacion, cantidadDisponible: cantidad },
        this.sedeSeleccionadaId(),
      );
      await this.inventoryService.guardarEnServidor();
      this.nuevoStock.marca = '';
      this.nuevoStock.especificacion = '';
      this.nuevoStock.cantidadDisponible = 0;
      this.guardandoModal.set(false);
      this.cerrarModal();
      this.mostrarToast('Se registró el saldo inicial de la sede.');
    } catch (error: unknown) {
      this.errorFormulario.set(
        error instanceof Error ? error.message : 'No se pudo guardar el saldo inicial.',
      );
    } finally {
      this.guardandoModal.set(false);
    }
  }

  abrirAjusteStock(insumo: StockInsumo): void {
    this.insumoEnAjusteId.set(insumo.id);
    this.cantidadAjuste.set(insumo.cantidadDisponible);
    this.motivoAjuste.set('');
    this.abrirModal('AJUSTE_STOCK');
  }

  async guardarAjusteStock(): Promise<void> {
    if (this.guardandoModal()) return;
    const insumo = this.insumoEnAjuste();
    const sedeStock =
      this.sedes().find((sede) => sede.id === (insumo?.sedeId ?? DEFAULT_SEDE_ID))?.nombre ??
      (insumo?.sedeId && insumo.sedeId !== DEFAULT_SEDE_ID
        ? 'Sede no identificada'
        : 'Casa Central');
    if (
      !window.confirm(
        `¿Confirmás ajustar el saldo de ${insumo ? `${insumo.marca} ${insumo.especificacion}` : 'este producto'}?\n\nSede: ${sedeStock}\nSaldo actual: ${insumo?.cantidadDisponible ?? 'No disponible'}\nNuevo saldo: ${this.cantidadAjuste()}\nMotivo: ${this.motivoAjuste().trim() || 'Sin motivo indicado'}`,
      )
    ) return;
    this.guardandoModal.set(true);
    try {
      this.inventoryService.ajustarStock(
        this.insumoEnAjusteId(),
        Number(this.cantidadAjuste()),
        this.motivoAjuste(),
      );
      await this.inventoryService.guardarEnServidor();
      this.guardandoModal.set(false);
      this.cerrarModal();
      this.mostrarToast('Se ajustó el saldo y quedó registrado el motivo.');
    } catch (error: unknown) {
      this.errorFormulario.set(
        error instanceof Error ? error.message : 'No se pudo ajustar el inventario.',
      );
    } finally {
      this.guardandoModal.set(false);
    }
  }

  async guardarNuevoPuesto(): Promise<void> {
    if (this.guardandoModal()) return;
    const pisoId = this.pisoSeleccionadoFormPuesto();
    const areaValida = this.areasFormPuesto().some((area) => area.id === this.nuevoPuesto.areaId);
    if (
      !pisoId ||
      !this.pisos().some((piso) => piso.id === pisoId) ||
      !areaValida ||
      !this.nuevoPuesto.nombrePuesto.trim() ||
      !this.nuevoPuesto.usuarioAsignado.trim()
    ) {
      this.errorFormulario.set('Seleccioná piso y área válidos, y completá los datos del puesto.');
      return;
    }
    const piso = this.pisos().find((item) => item.id === pisoId);
    const area = this.areasFormPuesto().find((item) => item.id === this.nuevoPuesto.areaId);
    if (
      !window.confirm(
        `¿Confirmás crear el puesto de trabajo?\n\nPuesto: ${this.nuevoPuesto.nombrePuesto.trim()}\nUsuario asignado: ${this.nuevoPuesto.usuarioAsignado.trim()}\nSede: ${this.sedeSeleccionada()?.nombre ?? 'Sede no identificada'}\nPiso: ${piso?.nombre ?? pisoId}\nÁrea: ${area?.nombre ?? this.nuevoPuesto.areaId}`,
      )
    ) return;
    this.guardandoModal.set(true);
    try {
      this.inventoryService.crearPuestoTrabajo({
        areaId: this.nuevoPuesto.areaId,
        nombrePuesto: this.nuevoPuesto.nombrePuesto.trim(),
        usuarioAsignado: this.nuevoPuesto.usuarioAsignado.trim(),
        componentes: [],
      });
      await this.inventoryService.guardarEnServidor();
      this.nuevoPuesto.nombrePuesto = '';
      this.nuevoPuesto.usuarioAsignado = '';
      this.guardandoModal.set(false);
      this.cerrarModal();
      this.mostrarToast('El puesto se registró correctamente.');
    } catch (error: unknown) {
      this.errorFormulario.set(
        error instanceof Error ? error.message : 'No se pudo registrar el puesto.',
      );
    } finally {
      this.guardandoModal.set(false);
    }
  }

  async guardarEquipoRed(): Promise<void> {
    if (this.guardandoModal()) return;
    const { areaId, marca, modelo } = this.nuevoEquipoRed;
    const pisoId = this.pisoSeleccionadoFormEquipoRed();
    const areaValida = this.areasFormEquipoRed().some((area) => area.id === areaId);
    if (
      !pisoId ||
      !this.pisos().some((piso) => piso.id === pisoId) ||
      !areaValida ||
      !marca.trim() ||
      !modelo.trim()
    ) {
      this.errorFormulario.set('Seleccioná piso y área válidos, e ingresá marca y modelo.');
      return;
    }

    const piso = this.pisos().find((item) => item.id === pisoId);
    const area = this.areasFormEquipoRed().find((item) => item.id === areaId);
    if (
      !window.confirm(
        `¿Confirmás registrar el equipo de red?\n\nEquipo: ${this.nuevoEquipoRed.tipo} · ${marca.trim()} · ${modelo.trim()}\nSede: ${this.sedeSeleccionada()?.nombre ?? 'Sede no identificada'}\nPiso: ${piso?.nombre ?? pisoId}\nÁrea: ${area?.nombre ?? areaId}`,
      )
    ) return;
    this.guardandoModal.set(true);
    try {
      this.inventoryService.crearEquipoRed({
        ...this.nuevoEquipoRed,
        marca: marca.trim(),
        modelo: modelo.trim(),
      });
      await this.inventoryService.guardarEnServidor();
      this.nuevoEquipoRed.marca = '';
      this.nuevoEquipoRed.modelo = '';
      this.guardandoModal.set(false);
      this.cerrarModal();
      this.mostrarToast('El equipo de red se registró correctamente.');
    } catch (error: unknown) {
      this.errorFormulario.set(
        error instanceof Error ? error.message : 'No se pudo registrar el equipo de red.',
      );
    } finally {
      this.guardandoModal.set(false);
    }
  }

  eliminarEquipoRed(equipo: EquipoRed): void {
    this.solicitarEliminacion('RED', equipo.id, `${equipo.tipo} ${equipo.marca} ${equipo.modelo}`);
  }

  async cambiarEstadoRetirado(id: string, estado: string): Promise<void> {
    if (this.componenteEstadoActualizandoId()) return;
    const estadoValidado = this.estadosComponente.find((opcion) => opcion === estado);
    if (!estadoValidado) {
      this.mostrarToast('El estado seleccionado no es válido.', 'error');
      return;
    }
    const componente = this.componentesRetirados().find((item) => item.id === id);
    if (
      !window.confirm(
        `¿Confirmás cambiar el estado del componente?\n\nComponente: ${componente ? `${componente.componente.tipo} · ${componente.componente.marca} ${componente.componente.modelo ?? ''}` : id}\nEstado: ${componente?.estado === 'SCRAP' ? 'Scrap / baja' : 'En reparación'} → ${estadoValidado === 'SCRAP' ? 'Scrap / baja' : 'En reparación'}\n${estadoValidado === 'SCRAP' ? 'El componente quedará marcado como dado de baja.' : 'El componente quedará registrado en seguimiento de reparación.'}`,
      )
    ) return;
    this.componenteEstadoActualizandoId.set(id);
    try {
      this.inventoryService.cambiarEstadoComponenteRetirado(id, estadoValidado);
      await this.inventoryService.guardarEnServidor();
      this.mostrarToast('Se actualizó el estado del componente.');
    } catch (error: unknown) {
      this.mostrarToast(
        error instanceof Error ? error.message : 'No se pudo actualizar el estado.',
        'error',
      );
    } finally {
      this.componenteEstadoActualizandoId.set(null);
    }
  }

  async imprimirEtiquetasDePuesto(puestoId: string): Promise<void> {
    const puesto = this.puestos().find((item) => item.id === puestoId);
    if (!puesto) {
      this.errorEtiquetas.set('No se encontró el puesto seleccionado.');
      this.mostrarToast('No se encontró el puesto seleccionado.', 'error');
      return;
    }

    this.errorEtiquetas.set('');
    this.codigoQrPuesto.set('');
    this.puestoEtiquetasId.set(puestoId);

    try {
      const { default: QRCode } = await import('qrcode');
      const contenidoQr = JSON.stringify({
        tipo: 'PUESTO_TRABAJO',
        id: puesto.id,
        codigoSeguimiento: puesto.codigoSeguimiento,
        nombre: puesto.nombrePuesto,
        usuario: puesto.usuarioAsignado,
        area: this.obtenerNombreArea(puesto.areaId),
      });
      const imagenQr = await QRCode.toDataURL(contenidoQr, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 220,
      });
      this.codigoQrPuesto.set(imagenQr);
      this.changeDetector.detectChanges();
      await this.renderizarCodigosBarras();
      await this.qrImage?.nativeElement.decode();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      window.print();
    } catch (error: unknown) {
      const detalle = error instanceof Error ? error.message : 'Error desconocido';
      this.errorEtiquetas.set(`No se pudieron preparar las etiquetas: ${detalle}`);
      this.mostrarToast(this.errorEtiquetas(), 'error');
    } finally {
      this.puestoEtiquetasId.set(null);
      this.codigoQrPuesto.set('');
      this.changeDetector.detectChanges();
    }
  }

  private async renderizarCodigosBarras(): Promise<void> {
    const { default: JsBarcode } = await import('jsbarcode');
    this.barcodeSvgs?.forEach(({ nativeElement }) => {
      const codigo = nativeElement.dataset['code'];
      if (codigo) {
        JsBarcode(nativeElement, codigo, {
          format: 'CODE128',
          lineColor: '#202a45',
          width: 1.7,
          height: 48,
          displayValue: false,
          fontSize: 11,
          margin: 4,
        });
      }
    });
  }

  async ejecutarReemplazo(): Promise<void> {
    const puesto = this.reemplazoPuesto();
    const componente = this.componenteSaliente();
    const insumo = this.insumoEntrante();
    const motivo = this.motivoReemplazo();

    if (!puesto || !componente) {
      this.reemplazoError.set('Seleccioná el equipo saliente que vas a retirar.');
      return;
    }
    if (!insumo) {
      this.reemplazoError.set('Seleccioná un equipo nuevo disponible en el stock.');
      return;
    }
    if (
      !this.reemplazoMotivoTipo() ||
      (this.reemplazoMotivoTipo() === 'Otro' && !this.reemplazoMotivoDetalle().trim())
    ) {
      this.reemplazoError.set('Indicá un motivo para el reemplazo.');
      return;
    }
    if (!this.reemplazoConfirmado()) {
      this.reemplazoError.set('Confirmá que revisaste los equipos y el movimiento de stock.');
      return;
    }

    this.reemplazoGuardando.set(true);
    this.reemplazoError.set('');
    try {
      this.inventoryService.reemplazarComponente(puesto.id, componente.id, insumo.id, motivo);
      await this.inventoryService.guardarEnServidor();
      this.cerrarReemplazoDespuesDeGuardar();
      this.mostrarToast(
        'Reemplazo confirmado. El equipo entrante quedó instalado y el stock actualizado.',
      );
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'No se pudo reemplazar el componente.';
      this.reemplazoError.set(message);
      this.mostrarToast(message, 'error');
    } finally {
      this.reemplazoGuardando.set(false);
    }
  }

  private cerrarReemplazoDespuesDeGuardar(): void {
    this.reemplazoModalAbierto.set(false);
    this.reemplazoPuestoId.set('');
    this.reemplazoComponenteId.set('');
    this.reemplazoStockId.set('');
    this.reemplazoStockBusqueda.set('');
    this.reemplazoMotivoDetalle.set('');
    this.reemplazoConfirmado.set(false);
    this.reemplazoError.set('');
  }

  eliminarPuesto(id: string) {
    const puesto = this.puestos().find((item) => item.id === id);
    if (puesto) this.solicitarEliminacion('PUESTO', id, puesto.nombrePuesto);
  }

  eliminarInsumo(id: string) {
    const insumo = this.stock().find((item) => item.id === id);
    if (insumo) this.solicitarEliminacion('STOCK', id, `${insumo.marca} ${insumo.especificacion}`);
  }

  eliminarPiso(id: string) {
    const piso = this.pisos().find((item) => item.id === id);
    if (piso) this.solicitarEliminacion('PISO', id, piso.nombre);
  }

  eliminarArea(id: string) {
    const area = this.areas().find((item) => item.id === id);
    if (area) this.solicitarEliminacion('AREA', id, area.nombre);
  }

  cambiarPisoFormularioPuesto(pisoId: string): void {
    this.pisoSeleccionadoFormPuesto.set(pisoId);
    this.nuevoPuesto.areaId = '';
  }

  cambiarPisoFormularioEquipoRed(pisoId: string): void {
    this.pisoSeleccionadoFormEquipoRed.set(pisoId);
    this.nuevoEquipoRed.areaId = '';
  }

  async exportarInventarioExcel(): Promise<void> {
    try {
      const { default: XLSX } = await import('xlsx-js-style');
      const sedeFiltro = this.sedeReporteId();
      const incluirSede = (sedeId: string | null | undefined): boolean =>
        sedeFiltro === 'TODAS' || sedeId === sedeFiltro;
      const nombreSede = (sedeId: string | null | undefined): string =>
        this.sedes().find((sede) => sede.id === sedeId)?.nombre ??
        (sedeId === DEFAULT_SEDE_ID ? 'Casa Central' : 'Sede no identificada');
      const pisosPorId = new Map(this.inventoryService.pisos().map((piso) => [piso.id, piso]));
      const areasTodos = this.inventoryService.areas().filter((area) => {
        const piso = pisosPorId.get(area.pisoId);
        return incluirSede(piso?.sedeId ?? DEFAULT_SEDE_ID);
      });
      const areasPorId = new Map(this.inventoryService.areas().map((area) => [area.id, area]));
      const sedeDeArea = (areaId: string): string => {
        const area = areasPorId.get(areaId);
        return area ? (pisosPorId.get(area.pisoId)?.sedeId ?? DEFAULT_SEDE_ID) : DEFAULT_SEDE_ID;
      };
      const puestosTodos = this.inventoryService
        .puestos()
        .filter((puesto) => incluirSede(sedeDeArea(puesto.areaId)));
      const stockTodos = this.inventoryService
        .stock()
        .filter((insumo) => incluirSede(insumo.sedeId ?? DEFAULT_SEDE_ID));
      const stockPorId = new Map(
        this.inventoryService.stock().map((insumo) => [insumo.id, insumo]),
      );
      const puestosPorId = new Map(
        this.inventoryService.puestos().map((puesto) => [puesto.id, puesto]),
      );
      const equiposRedTodos = this.inventoryService
        .equiposRed()
        .filter((equipo) => incluirSede(sedeDeArea(equipo.areaId)));
      const equiposRedPorId = new Map(
        this.inventoryService.equiposRed().map((equipo) => [equipo.id, equipo]),
      );
      const retiradosTodos = this.inventoryService.componentesRetirados().filter((componente) => {
        const puesto = puestosPorId.get(componente.puestoId);
        const sedeId =
          componente.sedeId ?? (puesto ? sedeDeArea(puesto.areaId) : undefined) ?? DEFAULT_SEDE_ID;
        return incluirSede(sedeId);
      });
      const [tickets, hardwareAssets] = await Promise.all([
        this.ticketsService.listar(),
        this.hardwareAssetsService.listar(),
        this.operatorTasksService.cargar(),
      ]);
      const tareas = this.operatorTasksService.tasks().filter((task) => incluirSede(task.sedeId));
      const reclamos = tickets.filter((ticket) => incluirSede(ticket.sede_id));
      const hardwareAssetsTodos = hardwareAssets.filter((asset) =>
        incluirSede(asset.sedeId ?? DEFAULT_SEDE_ID),
      );
      const sedeDeMovimiento = (movimiento: HistorialMovimiento): string | undefined => {
        if (movimiento.sedeId) return movimiento.sedeId;
        if (movimiento.insumoId) {
          const insumo = stockPorId.get(movimiento.insumoId);
          return insumo ? (insumo.sedeId ?? DEFAULT_SEDE_ID) : undefined;
        }
        if (movimiento.puestoId) {
          const puesto = puestosPorId.get(movimiento.puestoId);
          return puesto ? sedeDeArea(puesto.areaId) : undefined;
        }
        if (movimiento.equipoRedId) {
          const equipo = equiposRedPorId.get(movimiento.equipoRedId);
          return equipo ? sedeDeArea(equipo.areaId) : undefined;
        }
        return undefined;
      };
      const historialTodos = this.inventoryService.historial().filter((movimiento) => {
        const sedeId = sedeDeMovimiento(movimiento);
        if (movimiento.sedeDestinoId) {
          return incluirSede(movimiento.sedeId ?? sedeId) || incluirSede(movimiento.sedeDestinoId);
        }
        return sedeId ? incluirSede(sedeId) : sedeFiltro === 'TODAS';
      });
      const encabezadosPuestos = [
        'Sede',
        'PISO',
        'Área',
        'MONITOR',
        'Intel',
        'AMD',
        'Velocidad reloj',
        'Sistema operativo',
        'Memoria Ram',
        'usuario',
        'IP',
        'MAC',
        'Nombre de PC',
        'SCANER',
        'Fecha actualiz',
        'SERIE',
        'ACCION',
        'Observaciones',
      ];
      const filasPuestos = puestosTodos.map((puesto) => {
        const area = areasPorId.get(puesto.areaId);
        const piso = area ? pisosPorId.get(area.pisoId) : undefined;
        const componentes = puesto.componentes;
        const componentesDeTipo = (tipo: TipoPeriferico): string =>
          componentes
            .filter((componente) => componente.tipo === tipo)
            .map((componente) =>
              `${componente.marca} ${componente.modelo ?? ''} ${componente.especificacion}`.trim(),
            )
            .join(' | ');
        const procesador = componentes.find((componente) => componente.tipo === 'PROCESADOR');
        const fabricanteProcesador = procesador
          ? `${procesador.marca} ${procesador.modelo ?? ''} ${procesador.especificacion}`.toLocaleLowerCase()
          : '';
        const velocidadReloj = fabricanteProcesador.match(/\d+(?:[.,]\d+)?\s*ghz/i)?.[0] ?? '';
        const movimientosPuesto = historialTodos.filter(
          (movimiento) => movimiento.puestoId === puesto.id,
        );
        const ultimoMovimiento = movimientosPuesto.reduce<
          (typeof movimientosPuesto)[number] | undefined
        >(
          (ultimo, movimiento) =>
            !ultimo || movimiento.fecha > ultimo.fecha ? movimiento : ultimo,
          undefined,
        );
        const series = componentes
          .filter((componente) => componente.numeroSerie)
          .map((componente) => `${componente.tipo}: ${componente.numeroSerie}`)
          .join(' | ');
        const cpuNoClasificada =
          procesador &&
          !fabricanteProcesador.includes('intel') &&
          !fabricanteProcesador.includes('amd')
            ? `Procesador: ${procesador.marca} ${procesador.modelo ?? ''} ${procesador.especificacion}`.trim()
            : '';

        return [
          nombreSede(piso?.sedeId ?? DEFAULT_SEDE_ID),
          piso?.nivel ?? '',
          area?.nombre ?? 'Área no asignada',
          componentesDeTipo('MONITOR'),
          fabricanteProcesador.includes('intel') ? componentesDeTipo('PROCESADOR') : '',
          fabricanteProcesador.includes('amd') ? componentesDeTipo('PROCESADOR') : '',
          velocidadReloj,
          '',
          componentesDeTipo('RAM'),
          puesto.usuarioAsignado,
          '',
          '',
          puesto.nombrePuesto,
          componentesDeTipo('SCANNER'),
          ultimoMovimiento?.fecha ?? '',
          series,
          ultimoMovimiento?.tipo ?? '',
          [ultimoMovimiento?.detalle, cpuNoClasificada].filter(Boolean).join(' | '),
        ];
      });

      const filasStock = stockTodos.map((insumo) => [
        nombreSede(insumo.sedeId ?? DEFAULT_SEDE_ID),
        insumo.id,
        insumo.tipo,
        insumo.marca,
        insumo.especificacion,
        insumo.cantidadDisponible,
        insumo.stockMinimo,
      ]);

      const filasEquiposRed = equiposRedTodos.map((equipo) => [
        nombreSede(sedeDeArea(equipo.areaId)),
        areasPorId.get(equipo.areaId)?.nombre ?? '',
        equipo.tipo,
        equipo.marca,
        equipo.modelo,
        equipo.codigoSeguimiento,
      ]);
      const filasTareas = tareas.map((task) => [
        task.createdAt,
        task.sedeNombre || nombreSede(task.sedeId),
        task.tipo,
        task.titulo,
        task.descripcion,
        task.operador,
        task.duracionMinutos ?? '',
      ]);
      const filasHardwarePatrimonial = hardwareAssetsTodos.map((asset) => [
        nombreSede(asset.sedeId ?? DEFAULT_SEDE_ID),
        asset.tipo,
        asset.marca,
        asset.modelo ?? '',
        asset.especificacion ?? '',
        asset.numeroSerie,
        asset.numeroPatrimonio ?? '',
        asset.fechaRegistro,
      ]);
      const filasReclamos = reclamos.map((ticket) => [
        ticket.fecha_creacion,
        ticket.sede_nombre ?? nombreSede(ticket.sede_id),
        ticket.area_nombre ?? '',
        ticket.estado,
        ticket.categoria,
        ticket.titulo,
        ticket.descripcion,
        ticket.usuario_nombre,
        ticket.nombre_afectado ?? '',
        ticket.solucion ?? '',
        ticket.taller?.equipo ?? '',
        ticket.taller?.identificacion ?? '',
        ticket.taller?.estado ?? '',
        ticket.taller?.resultado_equipo ?? '',
        ticket.taller?.equipo_devuelto ?? '',
        ticket.taller?.identificacion_devuelta ?? '',
        ticket.taller?.motivo_reemplazo ?? '',
      ]);
      const filasHistorial = historialTodos.map((movimiento) => [
        movimiento.fecha,
        nombreSede(movimiento.sedeId ?? sedeDeMovimiento(movimiento) ?? null),
        movimiento.sedeDestinoId ? nombreSede(movimiento.sedeDestinoId) : '',
        movimiento.operador ?? '',
        movimiento.tipo,
        movimiento.cantidad,
        movimiento.detalle,
      ]);
      const filasAreas = areasTodos.map((area) => {
        const piso = pisosPorId.get(area.pisoId);
        return [
          nombreSede(piso?.sedeId ?? DEFAULT_SEDE_ID),
          piso?.nombre ?? '',
          piso?.nivel ?? '',
          area.nombre,
        ];
      });
      const sedesIncluidas = this.sedes().filter((sede) => incluirSede(sede.id));
      const libro = XLSX.utils.book_new();
      const tablas = [
        {
          nombre: 'Sedes',
          encabezados: ['Sede', 'Tipo', 'Departamento', 'Localidad', 'Dirección'],
          filas: sedesIncluidas.map((sede) => [
            sede.nombre,
            sede.tipo,
            sede.departamento,
            sede.localidad,
            sede.direccion,
          ]),
        },
        {
          nombre: 'Pisos y áreas',
          encabezados: ['Sede', 'Piso', 'Nivel', 'Área'],
          filas: filasAreas,
        },
        { nombre: 'Puestos', encabezados: encabezadosPuestos, filas: filasPuestos },
        {
          nombre: 'Stock',
          encabezados: [
            'Sede',
            'ID Insumo',
            'Tipo',
            'Marca',
            'Especificación',
            'Cantidad disponible',
            'Stock mínimo',
          ],
          filas: filasStock,
        },
        {
          nombre: 'Equipos de red',
          encabezados: ['Sede', 'Área', 'Tipo', 'Marca', 'Modelo', 'Código'],
          filas: filasEquiposRed,
        },
        {
          nombre: 'Hardware patrimonial',
          encabezados: [
            'Sede',
            'Tipo',
            'Marca',
            'Modelo',
            'Especificación',
            'Número de serie',
            'Número patrimonial',
            'Fecha de registro',
          ],
          filas: filasHardwarePatrimonial,
        },
        {
          nombre: 'Componentes retirados',
          encabezados: [
            'Sede',
            'Puesto',
            'Tipo',
            'Marca',
            'Modelo',
            'Especificación',
            'Estado',
            'Fecha de retiro',
          ],
          filas: retiradosTodos.map((item) => {
            const puesto = puestosPorId.get(item.puestoId);
            return [
              nombreSede(
                item.sedeId ?? (puesto ? sedeDeArea(puesto.areaId) : undefined) ?? DEFAULT_SEDE_ID,
              ),
              item.puestoNombre,
              item.componente.tipo,
              item.componente.marca,
              item.componente.modelo ?? '',
              item.componente.especificacion,
              item.estado,
              item.fechaRetiro,
            ];
          }),
        },
        {
          nombre: 'Tareas',
          encabezados: ['Fecha', 'Sede', 'Tipo', 'Tarea', 'Detalle', 'Operador', 'Duración (min)'],
          filas: filasTareas,
        },
        {
          nombre: 'Reclamos',
          encabezados: [
            'Fecha',
            'Sede',
            'Área',
            'Estado',
            'Categoría',
            'Asunto',
            'Descripción',
            'Solicitante',
            'Puesto o usuario afectado',
            'Solución',
            'Equipo enviado al taller',
            'Identificación',
            'Estado de aprobación',
            'Resultado del taller',
            'Equipo entregado',
            'Identificación entregada',
            'Motivo del reemplazo',
          ],
          filas: filasReclamos,
        },
        {
          nombre: 'Historial',
          encabezados: [
            'Fecha',
            'Sede de origen',
            'Sede de destino',
            'Operador',
            'Movimiento',
            'Cantidad',
            'Detalle',
          ],
          filas: filasHistorial,
        },
      ];
      const estiloEncabezado = {
        fill: { fgColor: { rgb: '26365B' } },
        font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 11 },
        alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
        border: {
          bottom: { style: 'medium', color: { rgb: '536B9D' } },
        },
      };
      const estiloCelda = {
        font: { color: { rgb: '293650' }, sz: 10 },
        alignment: { vertical: 'center', wrapText: true },
        border: {
          bottom: { style: 'thin', color: { rgb: 'E3E8F1' } },
        },
      };
      const aplicarEstiloTabla = (
        hoja: WorkSheet,
        cantidadFilas: number,
        cantidadColumnas: number,
      ): void => {
        for (let columna = 0; columna < cantidadColumnas; columna++) {
          const celdaEncabezado = hoja[XLSX.utils.encode_cell({ r: 0, c: columna })];
          if (celdaEncabezado) {
            celdaEncabezado.s = estiloEncabezado;
          }
        }

        for (let fila = 1; fila <= cantidadFilas; fila++) {
          for (let columna = 0; columna < cantidadColumnas; columna++) {
            const direccion = XLSX.utils.encode_cell({ r: fila, c: columna });
            const celda = hoja[direccion];
            if (celda) {
              celda.s = {
                ...estiloCelda,
                fill: {
                  fgColor: { rgb: fila % 2 === 0 ? 'F3F6FB' : 'FFFFFF' },
                },
              };
            }
          }
        }
        hoja['!rows'] = [{ hpt: 32 }];
      };

      const hojas = new Map<string, WorkSheet>();
      for (const tabla of tablas) {
        const hoja = XLSX.utils.aoa_to_sheet([tabla.encabezados, ...tabla.filas]);
        XLSX.utils.book_append_sheet(libro, hoja, tabla.nombre);
        aplicarEstiloTabla(hoja, tabla.filas.length, tabla.encabezados.length);
        hoja['!cols'] = tabla.encabezados.map((header, index) => {
          const longest = Math.max(
            header.length,
            ...tabla.filas.slice(0, 100).map((fila) => String(fila[index] ?? '').length),
          );
          return { wch: Math.min(Math.max(longest + 2, 12), 60) };
        });
        hoja['!autofilter'] = {
          ref: XLSX.utils.encode_range({
            s: { r: 0, c: 0 },
            e: { r: tabla.filas.length, c: tabla.encabezados.length - 1 },
          }),
        };
        hojas.set(tabla.nombre, hoja);
      }
      const hojaStock = hojas.get('Stock');
      if (hojaStock) {
        for (let fila = 0; fila < filasStock.length; fila++) {
          const insumo = stockTodos[fila];
          const celdaCantidad = hojaStock[XLSX.utils.encode_cell({ r: fila + 1, c: 5 })];
          if (insumo && celdaCantidad && insumo.cantidadDisponible <= insumo.stockMinimo) {
            celdaCantidad.s = {
              ...estiloCelda,
              fill: { fgColor: { rgb: 'FFF0EF' } },
              font: { bold: true, color: { rgb: 'B42318' }, sz: 10 },
            };
          }
        }
      }
      const sufijo =
        sedeFiltro === 'TODAS'
          ? 'todas-las-sedes'
          : (this.sedes()
              .find((sede) => sede.id === sedeFiltro)
              ?.nombre.toLowerCase()
              .replace(/[^a-z0-9]+/g, '-') ?? 'sede');
      XLSX.writeFile(libro, `gestion-it-${sufijo}-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (error: unknown) {
      const mensaje =
        error instanceof Error ? error.message : 'No se pudo generar el archivo Excel.';
      this.mostrarToast(`Error al exportar el inventario: ${mensaje}`, 'error');
    }
  }
}

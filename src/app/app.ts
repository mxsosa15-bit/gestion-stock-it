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
import { AuthService, type SystemRole } from './services/auth.service';
import { AssetLabelsComponent } from './components/asset-labels/asset-labels.component';
import { AreaAssetsExplorerComponent } from './components/area-assets-explorer/area-assets-explorer.component';
import { SupportTicketsComponent } from './components/support-tickets/support-tickets.component';
import { ReadOnlyDashboardComponent } from './components/read-only-dashboard/read-only-dashboard.component';
import { OperationsDashboardComponent } from './components/operations-dashboard/operations-dashboard.component';
import { WorkshopTicketsComponent } from './components/workshop-tickets/workshop-tickets.component';
import { InventoryTransfersComponent } from './components/inventory-transfers/inventory-transfers.component';
import {
  EquipoRed,
  EstadoComponenteRetirado,
  PuestoTrabajo,
  StockInsumo,
  TipoEquipoRed,
  TipoPeriferico,
} from './models/inventory.model';
import type { WorkSheet } from 'xlsx-js-style';

type ModalActivo =
  | 'NUEVO_PUESTO'
  | 'NUEVO_COMPONENTE'
  | 'NUEVO_STOCK'
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
  | 'TRANSFERENCIAS';

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
  ],
  templateUrl: './app.html',
})
export class App implements OnDestroy {
  inventoryService = inject(InventoryService);
  readonly authService = inject(AuthService);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private toastTimer?: ReturnType<typeof setTimeout>;
  readonly authUsuario = signal('');
  readonly authContrasena = signal('');
  readonly backupImportando = signal(false);
  readonly nuevoUsuario = signal({
    username: '',
    password: '',
    role: 'operator' as SystemRole,
    areaId: '',
  });
  readonly usuarioParaRestablecer = signal<string | null>(null);
  readonly nuevaContrasena = signal('');
  readonly usuarioRestableciendo = signal<string | null>(null);

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
    } catch {
      // The service exposes the connection error for the sign-in recovery view.
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
    const respaldo = this.inventoryService.exportarRespaldo();
    const contenido = new Blob([JSON.stringify(respaldo, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(contenido);
    const enlace = document.createElement('a');
    enlace.href = url;
    enlace.download = `gestion-it-respaldo-${new Date().toISOString().slice(0, 10)}.json`;
    enlace.click();
    URL.revokeObjectURL(url);
    this.mostrarToast('Se descargó el respaldo del inventario.');
  }

  async importarRespaldoJson(event: Event): Promise<void> {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const archivo = input.files?.[0];
    if (!archivo) return;

    this.backupImportando.set(true);
    try {
      const respaldo: unknown = JSON.parse(await archivo.text());
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
  puestos = this.inventoryService.puestos;
  stock = this.inventoryService.stock;
  historial = this.inventoryService.historial;
  pisos = this.inventoryService.pisos;
  areas = this.inventoryService.areas;
  equiposRed = this.inventoryService.equiposRed;
  componentesRetirados = this.inventoryService.componentesRetirados;
  readonly inventarioVacio = computed(() =>
    [
      this.pisos(),
      this.areas(),
      this.stock(),
      this.puestos(),
      this.equiposRed(),
      this.componentesRetirados(),
      this.historial(),
    ].every((coleccion) => coleccion.length === 0),
  );

  // Filtros parque
  readonly vistaParque = signal<'TARJETAS' | 'LISTA'>('TARJETAS');
  pisoSeleccionadoId = signal<string>('TODOS');
  areaSeleccionadaId = signal<string>('TODAS');
  busquedaParque = signal('');

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

    const consulta = this.normalizarBusqueda(this.busquedaParque());
    if (consulta) {
      resultado = resultado.filter(
        (puesto) =>
          this.normalizarBusqueda(puesto.usuarioAsignado).includes(consulta) ||
          puesto.componentes.some(
            (componente) =>
              this.normalizarBusqueda(componente.marca).includes(consulta) ||
              this.normalizarBusqueda(componente.modelo ?? '').includes(consulta) ||
              this.normalizarBusqueda(componente.numeroSerie ?? '').includes(consulta),
          ),
      );
    }

    return resultado;
  });
  readonly componentesStockBajo = computed(
    () => this.stock().filter((insumo) => insumo.cantidadDisponible <= insumo.stockMinimo).length,
  );

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
    this.vistaActiva.set(vista);
    this.menuMovilAbierto.set(false);
    if (vista === 'REPORTES' && this.authService.user()?.role === 'admin') {
      void this.cargarUsuarios();
    }
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
    }
    this.modalActivo.set(modal);
  }

  cerrarModal(): void {
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
    const puestoId = this.puestoComponenteId();
    const componente = this.nuevoComponenteManual();
    const marca = componente.marca.trim();
    const modelo = componente.modelo.trim();
    const caracteristicas = componente.caracteristicas.trim();
    if (!puestoId || !marca || !modelo || !caracteristicas) {
      this.errorFormulario.set('Completá marca, modelo y características del componente.');
      return;
    }

    try {
      const componenteGuardado = this.inventoryService.agregarComponenteManual(puestoId, {
        tipo: componente.tipo,
        marca,
        modelo,
        especificacion: caracteristicas,
      });
      await this.inventoryService.guardarEnServidor();
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
    }
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
    this.confirmacionPendiente.set({ tipo, id, nombre });
  }

  cancelarEliminacion(): void {
    this.confirmacionPendiente.set(null);
  }

  async confirmarEliminacion(): Promise<void> {
    const confirmacion = this.confirmacionPendiente();
    if (!confirmacion) return;

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
    }
  }

  // Guardar datos
  async guardarPiso(): Promise<void> {
    const nombre = this.nuevoPiso.nombre.trim();
    if (!nombre) {
      this.errorFormulario.set('Ingresá el nombre del piso.');
      return;
    }
    try {
      const piso = this.inventoryService.crearPiso(nombre, this.nuevoPiso.nivel);
      await this.inventoryService.guardarEnServidor();
      this.pisoSeleccionadoEdificio.set(piso.id);
      this.nuevoPiso = { nombre: '', nivel: this.nuevoPiso.nivel + 1 };
      this.cerrarModal();
      this.mostrarToast(`Se creó ${piso.nombre}.`);
    } catch (error: unknown) {
      this.errorFormulario.set(
        error instanceof Error ? error.message : 'No se pudo crear el piso.',
      );
    }
  }

  async guardarArea(): Promise<void> {
    const pisoId = this.pisoSeleccionadoEdificio();
    const nombre = this.nuevaArea.nombre.trim();
    if (!pisoId || !this.pisos().some((piso) => piso.id === pisoId) || !nombre) {
      this.errorFormulario.set('Seleccioná un piso e ingresá el nombre del área.');
      return;
    }
    try {
      this.inventoryService.crearArea(pisoId, nombre);
      await this.inventoryService.guardarEnServidor();
      this.nuevaArea.nombre = '';
      this.cerrarModal();
      this.mostrarToast(`Se creó el área ${nombre}.`);
    } catch (error: unknown) {
      this.errorFormulario.set(
        error instanceof Error ? error.message : 'No se pudo crear el área.',
      );
    }
  }

  async guardarNuevoStock(): Promise<void> {
    const marca = this.nuevoStock.marca.trim();
    const especificacion = this.nuevoStock.especificacion.trim();
    const cantidad = Number(this.nuevoStock.cantidadDisponible);
    if (!marca || !especificacion || !Number.isInteger(cantidad) || cantidad < 1) {
      this.errorFormulario.set('Ingresá marca, especificación y una cantidad entera mayor a cero.');
      return;
    }
    try {
      this.inventoryService.agregarInsumoStock({
        ...this.nuevoStock,
        marca,
        especificacion,
        cantidadDisponible: cantidad,
      });
      await this.inventoryService.guardarEnServidor();
      this.nuevoStock.marca = '';
      this.nuevoStock.especificacion = '';
      this.nuevoStock.cantidadDisponible = 1;
      this.cerrarModal();
      this.mostrarToast('El ingreso se agregó al stock.');
    } catch (error: unknown) {
      this.errorFormulario.set(
        error instanceof Error ? error.message : 'No se pudo guardar el stock.',
      );
    }
  }

  async guardarNuevoPuesto(): Promise<void> {
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
      this.cerrarModal();
      this.mostrarToast('El puesto se registró correctamente.');
    } catch (error: unknown) {
      this.errorFormulario.set(
        error instanceof Error ? error.message : 'No se pudo registrar el puesto.',
      );
    }
  }

  async guardarEquipoRed(): Promise<void> {
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

    try {
      this.inventoryService.crearEquipoRed({
        ...this.nuevoEquipoRed,
        marca: marca.trim(),
        modelo: modelo.trim(),
      });
      await this.inventoryService.guardarEnServidor();
      this.nuevoEquipoRed.marca = '';
      this.nuevoEquipoRed.modelo = '';
      this.cerrarModal();
      this.mostrarToast('El equipo de red se registró correctamente.');
    } catch (error: unknown) {
      this.errorFormulario.set(
        error instanceof Error ? error.message : 'No se pudo registrar el equipo de red.',
      );
    }
  }

  eliminarEquipoRed(equipo: EquipoRed): void {
    this.solicitarEliminacion('RED', equipo.id, `${equipo.tipo} ${equipo.marca} ${equipo.modelo}`);
  }

  async cambiarEstadoRetirado(id: string, estado: string): Promise<void> {
    const estadoValidado = this.estadosComponente.find((opcion) => opcion === estado);
    if (!estadoValidado) {
      this.mostrarToast('El estado seleccionado no es válido.', 'error');
      return;
    }
    try {
      this.inventoryService.cambiarEstadoComponenteRetirado(id, estadoValidado);
      await this.inventoryService.guardarEnServidor();
      this.mostrarToast('Se actualizó el estado del componente.');
    } catch (error: unknown) {
      this.mostrarToast(
        error instanceof Error ? error.message : 'No se pudo actualizar el estado.',
        'error',
      );
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
      const XLSX = await import('xlsx-js-style');
      const encabezadosPuestos = [
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
      const filasPuestos = this.puestos().map((puesto) => {
        const area = this.areas().find((item) => item.id === puesto.areaId);
        const piso = area ? this.pisos().find((item) => item.id === area.pisoId) : undefined;
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
        const movimientosPuesto = this.historial().filter(
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

      const filasStock = this.stock().map((insumo) => [
        insumo.id,
        insumo.tipo,
        insumo.marca,
        insumo.especificacion,
        insumo.cantidadDisponible,
        insumo.stockMinimo,
      ]);

      const libro = XLSX.utils.book_new();
      const hojaPuestos = XLSX.utils.aoa_to_sheet([encabezadosPuestos, ...filasPuestos]);
      const hojaStock = XLSX.utils.aoa_to_sheet([
        ['ID Insumo', 'Tipo', 'Marca', 'Especificación', 'Cantidad disponible', 'Stock mínimo'],
        ...filasStock,
      ]);

      XLSX.utils.book_append_sheet(libro, hojaPuestos, 'Puestos');
      XLSX.utils.book_append_sheet(libro, hojaStock, 'Stock');
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

      aplicarEstiloTabla(hojaPuestos, filasPuestos.length, encabezadosPuestos.length);
      aplicarEstiloTabla(hojaStock, filasStock.length, 6);
      hojaPuestos['!cols'] = [
        { wch: 8 },
        { wch: 24 },
        { wch: 24 },
        { wch: 22 },
        { wch: 22 },
        { wch: 18 },
        { wch: 22 },
        { wch: 20 },
        { wch: 20 },
        { wch: 18 },
        { wch: 20 },
        { wch: 22 },
        { wch: 20 },
        { wch: 18 },
        { wch: 32 },
        { wch: 24 },
        { wch: 60 },
      ];
      hojaPuestos['!autofilter'] = {
        ref: XLSX.utils.encode_range({
          s: { r: 0, c: 0 },
          e: { r: filasPuestos.length, c: encabezadosPuestos.length - 1 },
        }),
      };
      hojaStock['!cols'] = [
        { wch: 18 },
        { wch: 20 },
        { wch: 20 },
        { wch: 32 },
        { wch: 22 },
        { wch: 16 },
      ];
      for (let fila = 0; fila < filasStock.length; fila++) {
        const insumo = this.stock()[fila];
        const celdaCantidad = hojaStock[XLSX.utils.encode_cell({ r: fila + 1, c: 4 })];
        if (insumo && celdaCantidad && insumo.cantidadDisponible <= insumo.stockMinimo) {
          celdaCantidad.s = {
            ...estiloCelda,
            fill: { fgColor: { rgb: 'FFF0EF' } },
            font: { bold: true, color: { rgb: 'B42318' }, sz: 10 },
          };
        }
      }
      hojaStock['!autofilter'] = {
        ref: XLSX.utils.encode_range({
          s: { r: 0, c: 0 },
          e: { r: filasStock.length, c: 5 },
        }),
      };
      XLSX.writeFile(libro, `inventario-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (error: unknown) {
      const mensaje =
        error instanceof Error ? error.message : 'No se pudo generar el archivo Excel.';
      this.mostrarToast(`Error al exportar el inventario: ${mensaje}`, 'error');
    }
  }
}

import { CommonModule, DatePipe, isPlatformBrowser } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  signal,
  ViewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Chart } from 'chart.js';
import { DEFAULT_SEDE_ID } from '../../../shared/locations';
import { TICKET_CATEGORIES, type TicketCategory } from '../../../shared/tickets';
import type { Area, HistorialMovimiento } from '../../models/inventory.model';
import { AuthService } from '../../services/auth.service';
import { HardwareAssetsService, type HardwareAsset } from '../../services/hardware-assets.service';
import { OperatorTaskType, OperatorTasksService } from '../../services/operator-tasks.service';
import { InventoryService } from '../../services/inventory.service';
import { type DashboardLocation, LocationsService } from '../../services/locations.service';
import { TicketsService, type DashboardTicket } from '../../services/tickets.service';

type SiteFilter = 'ALL' | 'CENTRAL' | 'DELEGATIONS';
type PeriodFilter = '7' | '30' | '90' | 'ALL';

interface TicketEvent {
  id: string;
  action: 'created' | 'updated' | 'workshop';
}

interface DistributionRow {
  id: string;
  nombre: string;
  puestos: number;
  componentes: number;
  equiposRed: number;
  patrimonio: number;
}

const CATEGORY_COLORS = [
  '#3867f4',
  '#17b887',
  '#8a63f6',
  '#f3a43b',
  '#fa6b6b',
  '#1ca8c6',
  '#53657f',
  '#acb5c5',
];

const TASK_TYPES: readonly OperatorTaskType[] = [
  'Mantenimiento',
  'Instalación',
  'Configuración',
  'Relevamiento',
  'Otro',
];

@Component({
  selector: 'app-operations-dashboard',
  imports: [CommonModule, FormsModule, DatePipe],
  templateUrl: './operations-dashboard.component.html',
  styleUrl: './operations-dashboard.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OperationsDashboardComponent implements OnInit, AfterViewInit, OnDestroy {
  private readonly ticketsService = inject(TicketsService);
  private readonly inventoryService = inject(InventoryService);
  private readonly locationsService = inject(LocationsService);
  private readonly operatorTasksService = inject(OperatorTasksService);
  private readonly hardwareAssetsService = inject(HardwareAssetsService);
  private readonly authService = inject(AuthService);
  private readonly platformId = inject(PLATFORM_ID);
  private eventSource: EventSource | null = null;
  private categoryChart: Chart<'doughnut', number[], string> | null = null;
  private statusChart: Chart<'bar', number[], string> | null = null;
  private chartsReady = false;
  private requestSequence = 0;
  private arrivalTimer?: ReturnType<typeof setTimeout>;

  @ViewChild('categoryCanvas') private categoryCanvas?: ElementRef<HTMLCanvasElement>;
  @ViewChild('statusCanvas') private statusCanvas?: ElementRef<HTMLCanvasElement>;

  readonly tickets = signal<DashboardTicket[]>([]);
  readonly hardwareAssets = signal<HardwareAsset[]>([]);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly tasksLoading = signal(false);
  readonly tasksError = signal('');
  readonly hardwareAssetsLoading = signal(false);
  readonly hardwareAssetsError = signal('');
  readonly locationsError = signal('');
  readonly liveConnected = signal(false);
  readonly newestTicketId = signal('');
  readonly filtroSede = signal<SiteFilter>('ALL');
  readonly filtroDelegacionId = signal('ALL');
  readonly filtroAreaId = signal('ALL');
  readonly filtroPeriodo = signal<PeriodFilter>('30');
  readonly categories = TICKET_CATEGORIES;
  readonly taskTypes = TASK_TYPES;
  readonly todayLabel = new Intl.DateTimeFormat('es-AR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date());

  readonly sedes = signal<DashboardLocation[]>([]);
  readonly delegaciones = computed(() =>
    this.sedes()
      .filter((site) => site.tipo === 'DELEGACION')
      .sort((left, right) => left.nombre.localeCompare(right.nombre)),
  );
  readonly areasDisponibles = computed(() =>
    this.inventoryService
      .areas()
      .filter((area) => this.cumpleFiltroSede(this.sedeDeArea(area)))
      .sort((left, right) => left.nombre.localeCompare(right.nombre)),
  );
  readonly tareaDashboardDisponible = computed(() => {
    const role = this.authService.user()?.role;
    return role === 'admin' || role === 'operator';
  });
  readonly patrimonioDashboardDisponible = computed(
    () =>
      this.tareaDashboardDisponible() &&
      this.filtroAreaId() === 'ALL' &&
      !this.hardwareAssetsLoading() &&
      !this.hardwareAssetsError(),
  );
  readonly patrimonioFiltrado = computed(() =>
    this.patrimonioDashboardDisponible()
      ? this.hardwareAssets().filter((asset) =>
          this.cumpleFiltroSede(asset.sedeId ?? DEFAULT_SEDE_ID),
        )
      : [],
  );
  readonly metricasStockDisponibles = computed(() => this.filtroAreaId() === 'ALL');

  readonly puestosFiltrados = computed(() =>
    this.inventoryService
      .puestos()
      .filter(
        (puesto) =>
          this.cumpleFiltroSede(this.sedeDeAreaId(puesto.areaId)) &&
          (this.filtroAreaId() === 'ALL' || puesto.areaId === this.filtroAreaId()),
      ),
  );
  readonly equiposRedFiltrados = computed(() =>
    this.inventoryService
      .equiposRed()
      .filter(
        (equipo) =>
          this.cumpleFiltroSede(this.sedeDeAreaId(equipo.areaId)) &&
          (this.filtroAreaId() === 'ALL' || equipo.areaId === this.filtroAreaId()),
      ),
  );
  readonly componentesScrap = computed(
    () =>
      this.inventoryService
        .componentesRetirados()
        .filter(
          (component) =>
            component.estado === 'SCRAP' &&
            this.cumpleFiltroSede(component.sedeId ?? DEFAULT_SEDE_ID),
        ).length,
  );
  readonly componentesScrapDisponibles = computed(() => this.filtroAreaId() === 'ALL');
  readonly componentesRegistrados = computed(() =>
    this.puestosFiltrados().reduce((total, puesto) => total + puesto.componentes.length, 0),
  );
  readonly stockFiltrado = computed(() =>
    this.inventoryService
      .stock()
      .filter((item) => this.cumpleFiltroSede(item.sedeId ?? DEFAULT_SEDE_ID)),
  );
  readonly stockDisponibleUnidades = computed(() =>
    this.stockFiltrado().reduce((total, item) => total + item.cantidadDisponible, 0),
  );
  readonly lowStockItems = computed(() =>
    this.stockFiltrado()
      .filter((item) => item.cantidadDisponible > 0 && item.cantidadDisponible <= item.stockMinimo)
      .sort((left, right) => left.cantidadDisponible - right.cantidadDisponible),
  );
  readonly zeroStockItems = computed(() =>
    this.stockFiltrado()
      .filter((item) => item.cantidadDisponible <= 0)
      .sort((left, right) => left.marca.localeCompare(right.marca)),
  );
  readonly ticketsFiltrados = computed(() =>
    this.tickets().filter(
      (ticket) =>
        this.cumpleFiltroSede(ticket.sede_id ?? undefined) &&
        (this.filtroAreaId() === 'ALL' || ticket.inventory_area_id === this.filtroAreaId()) &&
        this.estaEnPeriodo(ticket.fecha_creacion),
    ),
  );
  readonly activeTickets = computed(() =>
    this.ticketsFiltrados().filter((ticket) => ticket.estado !== 'Terminado'),
  );
  readonly openTickets = computed(() =>
    this.ticketsFiltrados().filter((ticket) => ticket.estado === 'Abierto'),
  );
  readonly inProgressTickets = computed(() =>
    this.ticketsFiltrados().filter((ticket) => ticket.estado === 'En proceso'),
  );
  readonly resolvedTickets = computed(() =>
    this.ticketsFiltrados().filter((ticket) => ticket.estado === 'Terminado'),
  );
  readonly latestTickets = computed(() =>
    [...this.ticketsFiltrados()]
      .sort(
        (left, right) => this.timestamp(right.fecha_creacion) - this.timestamp(left.fecha_creacion),
      )
      .slice(0, 5),
  );
  readonly ticketsPorSede = computed(() => {
    const groups = new Map<string, { id: string; nombre: string; cantidad: number }>();
    for (const ticket of this.ticketsFiltrados()) {
      const id = ticket.sede_id ?? 'UNKNOWN';
      const group = groups.get(id) ?? {
        id,
        nombre: ticket.sede_nombre ?? this.nombreSede(ticket.sede_id),
        cantidad: 0,
      };
      group.cantidad += 1;
      groups.set(id, group);
    }
    return [...groups.values()].sort((left, right) => right.cantidad - left.cantidad);
  });
  readonly workshopEquipment = computed(
    () =>
      this.inventoryService
        .componentesRetirados()
        .filter(
          (component) =>
            component.estado === 'REPARACION' &&
            this.cumpleFiltroSede(component.sedeId ?? DEFAULT_SEDE_ID),
        ).length +
      this.ticketsFiltrados().filter((ticket) => ticket.taller?.estado === 'En taller').length,
  );
  readonly pendingApprovals = computed(
    () => this.ticketsFiltrados().filter((ticket) => ticket.taller?.estado === 'Pendiente').length,
  );
  readonly workshopMetricasDisponibles = computed(() => this.filtroAreaId() === 'ALL');

  readonly tareasFiltradas = computed(() =>
    this.operatorTasksService
      .tasks()
      .filter((task) => this.cumpleFiltroSede(task.sedeId) && this.estaEnPeriodo(task.createdAt)),
  );
  readonly tareasPorTipo = computed(() =>
    this.taskTypes.map((tipo) => ({
      tipo,
      cantidad: this.tareasFiltradas().filter((task) => task.tipo === tipo).length,
    })),
  );
  readonly tareasPorOperador = computed(() => {
    const groups = new Map<string, number>();
    for (const task of this.tareasFiltradas()) {
      groups.set(task.operador, (groups.get(task.operador) ?? 0) + 1);
    }
    return [...groups.entries()]
      .map(([operador, cantidad]) => ({ operador, cantidad }))
      .sort((left, right) => right.cantidad - left.cantidad)
      .slice(0, 5);
  });
  readonly cantidadOperadoresTareas = computed(
    () => new Set(this.tareasFiltradas().map((task) => task.operador)).size,
  );
  readonly tiposTareaConActividad = computed(
    () => this.tareasPorTipo().filter((row) => row.cantidad > 0).length,
  );
  readonly movimientosFiltrados = computed(() =>
    this.inventoryService
      .historial()
      .filter(
        (movement) =>
          this.movimientoCoincideConFiltros(movement) && this.estaEnPeriodo(movement.fecha),
      )
      .sort((left, right) => this.timestamp(right.fecha) - this.timestamp(left.fecha)),
  );
  readonly movimientosRecientes = computed(() => this.movimientosFiltrados().slice(0, 6));
  readonly resumenStockMovimientos = computed(() => {
    let ingresos = 0;
    let egresos = 0;
    let transferencias = 0;
    for (const movement of this.movimientosFiltrados()) {
      const quantity = Math.abs(movement.cantidad);
      if (movement.tipo === 'INGRESO_STOCK' || movement.tipo === 'SALDO_INICIAL') {
        ingresos += quantity;
      } else if (movement.tipo === 'AJUSTE_STOCK') {
        if (movement.cantidad > 0) ingresos += quantity;
        if (movement.cantidad < 0) egresos += quantity;
      } else if (movement.tipo === 'TRANSFERENCIA_STOCK') {
        if (this.filtroSede() === 'ALL' && this.filtroDelegacionId() === 'ALL') {
          transferencias += quantity;
          continue;
        }
        const source = this.cumpleFiltroSede(movement.sedeId ?? DEFAULT_SEDE_ID);
        const destination = this.cumpleFiltroSede(movement.sedeDestinoId);
        if (source && !destination) egresos += quantity;
        else if (destination && !source) ingresos += quantity;
        else transferencias += quantity;
      }
    }
    return { ingresos, egresos, transferencias };
  });
  readonly distribucionPorSede = computed(() => this.construirDistribucion('sede'));
  readonly distribucionPorArea = computed(() => this.construirDistribucion('area'));
  readonly periodoLabel = computed(() => {
    const period = this.filtroPeriodo();
    return period === 'ALL' ? 'Todo el historial' : `Últimos ${period} días`;
  });

  ngOnInit(): void {
    void this.cargarTickets(true);
    void this.cargarTareas();
    void this.cargarEquiposPatrimoniales();
    void this.cargarSedes();
    if (isPlatformBrowser(this.platformId)) this.conectarEventos();
  }

  ngAfterViewInit(): void {
    if (isPlatformBrowser(this.platformId)) void this.inicializarGraficos();
  }

  ngOnDestroy(): void {
    this.eventSource?.close();
    if (this.arrivalTimer) clearTimeout(this.arrivalTimer);
    this.categoryChart?.destroy();
    this.statusChart?.destroy();
  }

  cantidadCategoria(category: TicketCategory): number {
    return this.activeTickets().filter((ticket) => ticket.categoria === category).length;
  }

  categoryColor(index: number): string {
    return CATEGORY_COLORS[index] ?? CATEGORY_COLORS[CATEGORY_COLORS.length - 1]!;
  }

  cambiarFiltroSede(value: string): void {
    if (value !== 'ALL' && value !== 'CENTRAL' && value !== 'DELEGATIONS') return;
    this.filtroSede.set(value);
    if (value !== 'DELEGATIONS') this.filtroDelegacionId.set('ALL');
    this.filtroAreaId.set('ALL');
    this.actualizarGraficos();
  }

  cambiarFiltroDelegacion(value: string): void {
    this.filtroDelegacionId.set(value);
    if (value !== 'ALL') this.filtroSede.set('DELEGATIONS');
    this.filtroAreaId.set('ALL');
    this.actualizarGraficos();
  }

  cambiarFiltroArea(value: string): void {
    this.filtroAreaId.set(value);
    this.actualizarGraficos();
  }

  cambiarFiltroPeriodo(value: string): void {
    if (value !== '7' && value !== '30' && value !== '90' && value !== 'ALL') return;
    this.filtroPeriodo.set(value);
    this.actualizarGraficos();
  }

  reintentar(): void {
    void this.cargarTickets(true);
    void this.cargarTareas();
    void this.cargarEquiposPatrimoniales();
    void this.cargarSedes();
  }

  nombreSede(sedeId: string | null | undefined): string {
    if (!sedeId) return 'Sede no identificada';
    return (
      this.sedes().find((site) => site.id === sedeId)?.nombre ??
      (sedeId === DEFAULT_SEDE_ID ? 'Casa Central' : 'Sede no identificada')
    );
  }

  areaSede(area: Area): string {
    return this.sedeDeAreaId(area.id);
  }

  nombreSedeMovimiento(movement: HistorialMovimiento): string {
    return this.nombreSede(this.sedeDeMovimiento(movement));
  }

  private async inicializarGraficos(): Promise<void> {
    const categoryCanvas = this.categoryCanvas?.nativeElement;
    const statusCanvas = this.statusCanvas?.nativeElement;
    if (!categoryCanvas || !statusCanvas) return;

    const { default: ChartJS } = await import('chart.js/auto');
    this.categoryChart = new ChartJS(categoryCanvas, {
      type: 'doughnut',
      data: {
        labels: [...this.categories],
        datasets: [
          {
            data: this.categories.map((category) => this.cantidadCategoria(category)),
            backgroundColor: CATEGORY_COLORS,
            borderColor: '#ffffff',
            borderWidth: 4,
            hoverOffset: 7,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '72%',
        plugins: {
          legend: { display: false },
          tooltip: { padding: 11, displayColors: true },
        },
      },
    });

    this.statusChart = new ChartJS(statusCanvas, {
      type: 'bar',
      data: {
        labels: ['Abierto', 'En proceso', 'Terminado'],
        datasets: [
          {
            label: 'Tickets',
            data: [0, 0, 0],
            backgroundColor: ['#f3a43b', '#3867f4', '#17b887'],
            borderRadius: 7,
            maxBarThickness: 42,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { padding: 11 },
        },
        scales: {
          x: {
            grid: { display: false },
            border: { display: false },
            ticks: { color: '#75819a', font: { family: 'Inter, sans-serif', size: 11 } },
          },
          y: {
            beginAtZero: true,
            border: { display: false, dash: [4, 4] },
            grid: { color: '#edf0f6' },
            ticks: {
              color: '#75819a',
              precision: 0,
              stepSize: 1,
              font: { family: 'Inter, sans-serif', size: 10 },
            },
          },
        },
      },
    });
    this.chartsReady = true;
    this.actualizarGraficos();
  }

  private actualizarGraficos(): void {
    if (!this.chartsReady || !this.categoryChart || !this.statusChart) return;

    this.categoryChart.data.datasets[0]!.data = this.categories.map((category) =>
      this.cantidadCategoria(category),
    );
    this.categoryChart.update();
    this.statusChart.data.datasets[0]!.data = [
      this.openTickets().length,
      this.inProgressTickets().length,
      this.resolvedTickets().length,
    ];
    this.statusChart.update();
  }

  private conectarEventos(): void {
    this.eventSource = new EventSource('/api/tickets/events');
    this.eventSource.onopen = () => this.liveConnected.set(true);
    this.eventSource.onerror = () => this.liveConnected.set(false);
    this.eventSource.addEventListener('ticket', (event: MessageEvent<string>) => {
      let payload: TicketEvent;
      try {
        const parsed: unknown = JSON.parse(event.data);
        if (
          !parsed ||
          typeof parsed !== 'object' ||
          !('id' in parsed) ||
          typeof parsed.id !== 'string' ||
          !('action' in parsed) ||
          (parsed.action !== 'created' &&
            parsed.action !== 'updated' &&
            parsed.action !== 'workshop')
        ) {
          throw new Error('Formato de evento no válido.');
        }
        payload = { id: parsed.id, action: parsed.action };
      } catch (error: unknown) {
        console.error('No se pudo interpretar el aviso de tickets del dashboard.', error);
        return;
      }

      if (payload.action === 'created') this.animarNuevoTicket(payload.id);
      void this.cargarTickets(false);
    });
  }

  private animarNuevoTicket(ticketId: string): void {
    this.newestTicketId.set(ticketId);
    if (this.arrivalTimer) clearTimeout(this.arrivalTimer);
    this.arrivalTimer = setTimeout(() => this.newestTicketId.set(''), 4_000);
  }

  private async cargarTickets(showLoading: boolean): Promise<void> {
    const requestSequence = ++this.requestSequence;
    if (showLoading) this.loading.set(true);
    this.error.set('');
    try {
      const tickets = await this.ticketsService.listarParaDashboard();
      if (requestSequence !== this.requestSequence) return;
      this.tickets.set(tickets);
      this.actualizarGraficos();
    } catch (error: unknown) {
      if (requestSequence === this.requestSequence) {
        this.error.set(
          error instanceof Error ? error.message : 'No se pudieron cargar los datos del dashboard.',
        );
      }
    } finally {
      if (requestSequence === this.requestSequence) this.loading.set(false);
    }
  }

  private async cargarTareas(): Promise<void> {
    if (!this.tareaDashboardDisponible()) return;
    this.tasksLoading.set(true);
    this.tasksError.set('');
    try {
      await this.operatorTasksService.cargar();
    } catch (error: unknown) {
      this.tasksError.set(
        error instanceof Error ? error.message : 'No se pudieron cargar las tareas registradas.',
      );
    } finally {
      this.tasksLoading.set(false);
    }
  }

  private async cargarEquiposPatrimoniales(): Promise<void> {
    if (!this.tareaDashboardDisponible()) return;
    this.hardwareAssetsLoading.set(true);
    this.hardwareAssetsError.set('');
    try {
      this.hardwareAssets.set(await this.hardwareAssetsService.listar());
    } catch (error: unknown) {
      this.hardwareAssetsError.set(
        error instanceof Error ? error.message : 'No se pudieron cargar los equipos patrimoniales.',
      );
    } finally {
      this.hardwareAssetsLoading.set(false);
    }
  }

  private async cargarSedes(): Promise<void> {
    if (this.sedes().length > 0) return;
    this.locationsError.set('');
    try {
      const currentLocations = this.locationsService.sedes();
      this.sedes.set(
        currentLocations.length > 0
          ? currentLocations
          : await this.locationsService.listarParaDashboard(),
      );
    } catch (error: unknown) {
      this.locationsError.set(
        error instanceof Error ? error.message : 'No se pudieron cargar las sedes.',
      );
    }
  }

  private cumpleFiltroSede(sedeId: string | undefined): boolean {
    if (!sedeId) return this.filtroSede() === 'ALL' && this.filtroDelegacionId() === 'ALL';
    if (this.filtroDelegacionId() !== 'ALL' && sedeId !== this.filtroDelegacionId()) return false;
    const site = this.sedes().find((item) => item.id === sedeId);
    const isCentral = site?.tipo === 'CENTRAL' || sedeId === DEFAULT_SEDE_ID;
    if (this.filtroSede() === 'CENTRAL') return isCentral;
    if (this.filtroSede() === 'DELEGATIONS') return site?.tipo === 'DELEGACION';
    return true;
  }

  private sedeDeArea(area: Area): string {
    return this.sedeDeAreaId(area.id);
  }

  private sedeDeAreaId(areaId: string): string {
    const area = this.inventoryService.areas().find((item) => item.id === areaId);
    const floor = area
      ? this.inventoryService.pisos().find((item) => item.id === area.pisoId)
      : undefined;
    return floor?.sedeId ?? DEFAULT_SEDE_ID;
  }

  private estaEnPeriodo(value: string | Date): boolean {
    const period = this.filtroPeriodo();
    const timestamp = this.timestamp(value);
    if (timestamp === 0) return false;
    if (period === 'ALL') return true;

    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - Number(period) + 1);
    return timestamp >= start.getTime() && timestamp <= Date.now();
  }

  private timestamp(value: string | Date): number {
    const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isNaN(timestamp) ? 0 : timestamp;
  }

  private movimientoCoincideConFiltros(movement: HistorialMovimiento): boolean {
    const sourceSite = this.sedeDeMovimiento(movement);
    if (
      movement.sedeDestinoId
        ? !(this.cumpleFiltroSede(sourceSite) || this.cumpleFiltroSede(movement.sedeDestinoId))
        : !this.cumpleFiltroSede(sourceSite)
    ) {
      return false;
    }
    if (this.filtroAreaId() === 'ALL') return true;
    const areaId = movement.puestoId
      ? this.inventoryService.puestos().find((item) => item.id === movement.puestoId)?.areaId
      : movement.equipoRedId
        ? this.inventoryService.equiposRed().find((item) => item.id === movement.equipoRedId)
            ?.areaId
        : undefined;
    return areaId === this.filtroAreaId();
  }

  private sedeDeMovimiento(movement: HistorialMovimiento): string | undefined {
    if (movement.sedeId) return movement.sedeId;
    if (movement.insumoId) {
      const item = this.inventoryService.stock().find((stock) => stock.id === movement.insumoId);
      return item?.sedeId ?? DEFAULT_SEDE_ID;
    }
    if (movement.puestoId) {
      const puesto = this.inventoryService.puestos().find((item) => item.id === movement.puestoId);
      return puesto ? this.sedeDeAreaId(puesto.areaId) : undefined;
    }
    if (movement.equipoRedId) {
      const equipment = this.inventoryService
        .equiposRed()
        .find((item) => item.id === movement.equipoRedId);
      return equipment ? this.sedeDeAreaId(equipment.areaId) : undefined;
    }
    return undefined;
  }

  private construirDistribucion(level: 'sede' | 'area'): DistributionRow[] {
    const groups = new Map<string, DistributionRow>();
    const getGroup = (id: string, nombre: string): DistributionRow => {
      let group = groups.get(id);
      if (!group) {
        group = { id, nombre, puestos: 0, componentes: 0, equiposRed: 0, patrimonio: 0 };
        groups.set(id, group);
      }
      return group;
    };

    for (const puesto of this.puestosFiltrados()) {
      const area = this.inventoryService.areas().find((item) => item.id === puesto.areaId);
      const siteId = this.sedeDeAreaId(puesto.areaId);
      const groupId = level === 'area' ? puesto.areaId : siteId;
      const groupName =
        level === 'area' ? (area?.nombre ?? 'Área no identificada') : this.nombreSede(siteId);
      const group = getGroup(groupId, groupName);
      group.puestos += 1;
      group.componentes += puesto.componentes.length;
    }
    for (const equipment of this.equiposRedFiltrados()) {
      const area = this.inventoryService.areas().find((item) => item.id === equipment.areaId);
      const siteId = this.sedeDeAreaId(equipment.areaId);
      const groupId = level === 'area' ? equipment.areaId : siteId;
      const groupName =
        level === 'area' ? (area?.nombre ?? 'Área no identificada') : this.nombreSede(siteId);
      const group = getGroup(groupId, groupName);
      group.equiposRed += 1;
    }
    if (level === 'sede') {
      for (const asset of this.patrimonioFiltrado()) {
        const siteId = asset.sedeId ?? DEFAULT_SEDE_ID;
        const group = getGroup(siteId, this.nombreSede(siteId));
        group.patrimonio += 1;
      }
    }
    return [...groups.values()].sort(
      (left, right) =>
        right.puestos +
          right.equiposRed +
          right.patrimonio -
          (left.puestos + left.equiposRed + left.patrimonio) ||
        left.nombre.localeCompare(right.nombre),
    );
  }
}

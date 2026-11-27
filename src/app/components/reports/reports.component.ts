import { CommonModule, DatePipe, isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  OnInit,
  PLATFORM_ID,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TICKET_CATEGORIES } from '../../../shared/tickets';
import { AuthService } from '../../services/auth.service';
import { LocationsService } from '../../services/locations.service';
import {
  ReportFilters,
  ReportId,
  ReportPreview,
  ReportsService,
} from '../../services/reports.service';

const REPORT_OPTIONS: { id: ReportId; label: string }[] = [
  { id: 'inventory', label: 'Inventario y patrimonio' },
  { id: 'stock', label: 'Stock y movimientos' },
  { id: 'transfers', label: 'Transferencias' },
  { id: 'tickets', label: 'Tickets' },
  { id: 'tasks', label: 'Tareas de operadores' },
  { id: 'activity', label: 'Registro de actividades' },
];

const TASK_TYPES = ['Mantenimiento', 'Instalación', 'Configuración', 'Relevamiento', 'Otro'];
const TRANSFER_TYPES = [
  { value: 'STOCK', label: 'Stock entre sedes' },
  { value: 'AREA', label: 'Área' },
  { value: 'PERSONA', label: 'Persona' },
  { value: 'COMPONENTE', label: 'Componente' },
  { value: 'EQUIPO_RED', label: 'Equipo de red' },
];
const INVENTORY_CLASSES = ['PUESTO', 'COMPONENTE', 'EQUIPO_RED', 'PATRIMONIAL', 'COMPONENTE_RETIRADO'];
const STOCK_TYPES = [
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
const TICKET_STATES = ['Abierto', 'En proceso', 'Terminado'];

function isReportId(value: string): value is ReportId {
  return REPORT_OPTIONS.some((option) => option.id === value);
}

@Component({
  selector: 'app-reports',
  standalone: true,
  imports: [CommonModule, FormsModule, DatePipe],
  templateUrl: './reports.component.html',
  styleUrl: './reports.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReportsComponent implements OnInit {
  private readonly reportService = inject(ReportsService);
  private readonly platformId = inject(PLATFORM_ID);
  private requestSequence = 0;
  readonly authService = inject(AuthService);
  readonly locationsService = inject(LocationsService);
  readonly reportOptions = computed(() =>
    this.authService.user()?.role === 'admin'
      ? REPORT_OPTIONS
      : REPORT_OPTIONS.filter((option) => option.id !== 'activity'),
  );
  readonly reportId = signal<ReportId>('inventory');
  readonly page = signal(1);
  readonly pageSize = 25;
  readonly preview = signal<ReportPreview | null>(null);
  readonly appliedFiltersKey = signal('');
  readonly loading = signal(false);
  readonly exportingExcel = signal(false);
  readonly error = signal('');
  readonly search = signal('');
  readonly site = signal('');
  readonly area = signal('');
  readonly operator = signal('');
  readonly from = signal('');
  readonly to = signal('');
  readonly state = signal('');
  readonly category = signal('');
  readonly type = signal('');
  readonly module = signal('');
  readonly action = signal('');
  readonly sort = signal<'newest' | 'oldest'>('newest');
  readonly totalPages = computed(() =>
    Math.max(1, Math.ceil((this.preview()?.total ?? 0) / this.pageSize)),
  );
  readonly ticketCategories = TICKET_CATEGORIES;
  readonly taskTypes = TASK_TYPES;
  readonly transferTypes = TRANSFER_TYPES;
  readonly inventoryClasses = INVENTORY_CLASSES;
  readonly stockTypes = STOCK_TYPES;
  readonly ticketStates = TICKET_STATES;
  readonly previewMatchesFilters = computed(
    () =>
      this.preview() !== null &&
      this.appliedFiltersKey() ===
        JSON.stringify({ reportId: this.reportId(), filters: this.obtenerFiltros() }),
  );
  readonly stockStates = [
    { value: 'BAJO', label: 'Stock bajo' },
    { value: 'SIN_STOCK', label: 'Sin stock' },
    { value: 'DISPONIBLE', label: 'Disponible' },
  ];
  readonly isAdmin = computed(() => this.authService.user()?.role === 'admin');

  ngOnInit(): void {
    void this.consultar();
  }

  async cambiarReporte(value: string): Promise<void> {
    if (!isReportId(value)) return;
    const reportId = value;
    if (reportId === 'activity' && !this.isAdmin()) return;
    this.reportId.set(reportId);
    this.limpiarValoresFiltro();
    await this.consultar(1);
  }

  async consultar(page = 1): Promise<void> {
    const sequence = ++this.requestSequence;
    this.page.set(page);
    this.loading.set(true);
    this.error.set('');
    const filters = this.obtenerFiltros();
    try {
      const result = await this.reportService.consultar(
        this.reportId(),
        filters,
        page,
        this.pageSize,
      );
      if (sequence === this.requestSequence) {
        this.preview.set(result);
        this.appliedFiltersKey.set(JSON.stringify({ reportId: this.reportId(), filters }));
      }
    } catch (error: unknown) {
      if (sequence === this.requestSequence) {
        this.error.set(error instanceof Error ? error.message : 'No se pudo consultar el reporte.');
      }
    } finally {
      if (sequence === this.requestSequence) this.loading.set(false);
    }
  }

  aplicarFiltros(): void {
    void this.consultar(1);
  }

  limpiarFiltros(): void {
    this.limpiarValoresFiltro();
    void this.consultar(1);
  }

  paginaAnterior(): void {
    if (this.page() > 1) void this.consultar(this.page() - 1);
  }

  paginaSiguiente(): void {
    if (this.page() < this.totalPages()) void this.consultar(this.page() + 1);
  }

  async exportarExcel(): Promise<void> {
    this.exportingExcel.set(true);
    this.error.set('');
    try {
      const blob = await this.reportService.descargarExcel(this.reportId(), this.obtenerFiltros());
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `gestion-stock-it-${this.reportId()}-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'No se pudo generar el archivo Excel.');
    } finally {
      this.exportingExcel.set(false);
    }
  }

  exportarPdf(): void {
    if (!isPlatformBrowser(this.platformId) || !this.previewMatchesFilters()) return;
    const anchor = document.createElement('a');
    anchor.href = this.reportService.urlImpresion(this.reportId(), this.obtenerFiltros());
    anchor.target = '_blank';
    anchor.rel = 'noopener';
    anchor.click();
  }

  valorCelda(row: Record<string, string | number | null>, key: string): string | number {
    return row[key] ?? '—';
  }

  private obtenerFiltros(): ReportFilters {
    return {
      search: this.search(),
      site: this.site(),
      area: this.area(),
      operator: this.operator(),
      from: this.from(),
      to: this.to(),
      state: this.state(),
      category: this.category(),
      type: this.type(),
      module: this.module(),
      action: this.action(),
      sort: this.sort(),
    };
  }

  private limpiarValoresFiltro(): void {
    this.search.set('');
    this.site.set('');
    this.area.set('');
    this.operator.set('');
    this.from.set('');
    this.to.set('');
    this.state.set('');
    this.category.set('');
    this.type.set('');
    this.module.set('');
    this.action.set('');
    this.sort.set('newest');
  }
}

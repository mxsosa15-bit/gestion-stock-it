import { CommonModule, DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  OnChanges,
  signal,
  SimpleChanges,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TICKET_CATEGORIES } from '../../../shared/tickets';
import { InventoryService } from '../../services/inventory.service';
import { SupportTicket, TicketsService } from '../../services/tickets.service';
import { DEFAULT_SEDE_ID } from '../../../shared/locations';

@Component({
  selector: 'app-area-assets-explorer',
  imports: [CommonModule, FormsModule, DatePipe],
  templateUrl: './area-assets-explorer.component.html',
  styleUrl: './area-assets-explorer.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AreaAssetsExplorerComponent implements OnChanges {
  private readonly inventoryService = inject(InventoryService);
  private readonly ticketsService = inject(TicketsService);
  private ticketRequestSequence = 0;

  readonly sedeId = input.required<string>();
  readonly pisos = computed(() =>
    this.inventoryService
      .pisos()
      .filter((piso) => (piso.sedeId ?? DEFAULT_SEDE_ID) === this.sedeId()),
  );
  readonly areas = computed(() => {
    const pisoIds = new Set(this.pisos().map((piso) => piso.id));
    return this.inventoryService.areas().filter((area) => pisoIds.has(area.pisoId));
  });
  readonly puestos = computed(() => {
    const areaIds = new Set(this.areas().map((area) => area.id));
    return this.inventoryService.puestos().filter((puesto) => areaIds.has(puesto.areaId));
  });
  readonly equiposRed = computed(() => {
    const areaIds = new Set(this.areas().map((area) => area.id));
    return this.inventoryService.equiposRed().filter((equipo) => areaIds.has(equipo.areaId));
  });
  readonly pisoSeleccionadoId = signal('');
  readonly areaSeleccionadaId = signal('');
  readonly busquedaActivos = signal('');
  readonly tipoComponente = signal('');
  readonly tipoEquipoRed = signal('');
  readonly paginaPuestos = signal(1);
  readonly paginaEquiposRed = signal(1);
  readonly resultadosPorPagina = 15;
  readonly tickets = signal<SupportTicket[]>([]);
  readonly categoriasTickets = TICKET_CATEGORIES;
  readonly estadosTickets = ['Abierto', 'En proceso', 'Terminado'] as const;
  readonly totalTickets = signal(0);
  readonly loadingTickets = signal(false);
  readonly error = signal('');
  readonly filtroTicketsTexto = signal('');
  readonly filtroTicketsResponsable = signal('');
  readonly filtroTicketsEstado = signal('');
  readonly filtroTicketsCategoria = signal('');
  readonly ticketsDesde = signal('');
  readonly ticketsHasta = signal('');
  readonly ordenTickets = signal<'newest' | 'oldest'>('newest');
  readonly paginaTickets = signal(1);
  readonly ticketsPorPagina = 20;
  readonly totalPaginasTickets = computed(() =>
    Math.max(1, Math.ceil(this.totalTickets() / this.ticketsPorPagina)),
  );
  readonly areasDelPiso = computed(() => {
    const pisoId = this.pisoSeleccionadoId();
    return pisoId ? this.areas().filter((area) => area.pisoId === pisoId) : [];
  });
  readonly areaSeleccionada = computed(
    () => this.areas().find((area) => area.id === this.areaSeleccionadaId()) ?? null,
  );
  readonly puestosDelArea = computed(() => {
    let result = this.puestos().filter((puesto) => puesto.areaId === this.areaSeleccionadaId());
    const componentType = this.tipoComponente();
    const search = this.normalizar(this.busquedaActivos());
    if (componentType) {
      result = result.filter((puesto) =>
        puesto.componentes.some((component) => component.tipo === componentType),
      );
    }
    if (search) {
      result = result.filter((puesto) =>
        this.normalizar(
          [
            puesto.nombrePuesto,
            puesto.usuarioAsignado,
            puesto.codigoSeguimiento,
            ...puesto.componentes.flatMap((component) => [
              component.tipo,
              component.marca,
              component.modelo ?? '',
              component.especificacion,
              component.numeroSerie ?? '',
              component.codigoSeguimiento ?? '',
            ]),
          ].join(' '),
        ).includes(search),
      );
    }
    return result;
  });
  readonly equiposRedDelArea = computed(() => {
    let result = this.equiposRed().filter((equipo) => equipo.areaId === this.areaSeleccionadaId());
    const type = this.tipoEquipoRed();
    const search = this.normalizar(this.busquedaActivos());
    if (type) result = result.filter((equipo) => equipo.tipo === type);
    if (search) {
      result = result.filter((equipo) =>
        this.normalizar(
          [equipo.tipo, equipo.marca, equipo.modelo, equipo.codigoSeguimiento].join(' '),
        ).includes(search),
      );
    }
    return result;
  });
  readonly paginasPuestos = computed(() =>
    Math.max(1, Math.ceil(this.puestosDelArea().length / this.resultadosPorPagina)),
  );
  readonly puestosPaginados = computed(() => {
    const page = Math.min(this.paginaPuestos(), this.paginasPuestos());
    const start = (page - 1) * this.resultadosPorPagina;
    return this.puestosDelArea().slice(start, start + this.resultadosPorPagina);
  });
  readonly paginasEquiposRed = computed(() =>
    Math.max(1, Math.ceil(this.equiposRedDelArea().length / this.resultadosPorPagina)),
  );
  readonly equiposRedPaginados = computed(() => {
    const page = Math.min(this.paginaEquiposRed(), this.paginasEquiposRed());
    const start = (page - 1) * this.resultadosPorPagina;
    return this.equiposRedDelArea().slice(start, start + this.resultadosPorPagina);
  });
  readonly cantidadEquipos = computed(
    () =>
      this.puestosDelArea().length +
      this.puestosDelArea().reduce((total, puesto) => total + puesto.componentes.length, 0) +
      this.equiposRedDelArea().length,
  );
  readonly tiposComponenteDisponibles = computed(() =>
    [...new Set(this.puestos().flatMap((puesto) =>
      puesto.areaId === this.areaSeleccionadaId()
        ? puesto.componentes.map((component) => component.tipo)
        : [],
    ))].sort(),
  );
  readonly tiposRedDisponibles = computed(() =>
    [...new Set(
      this.equiposRed()
        .filter((equipo) => equipo.areaId === this.areaSeleccionadaId())
        .map((equipo) => equipo.tipo),
    )].sort(),
  );

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['sedeId'] && !changes['sedeId'].firstChange) {
      this.ticketRequestSequence++;
      this.pisoSeleccionadoId.set('');
      this.areaSeleccionadaId.set('');
      this.limpiarFiltrosActivos();
      this.tickets.set([]);
      this.totalTickets.set(0);
      this.loadingTickets.set(false);
      this.error.set('');
    }
  }

  seleccionarPiso(pisoId: string): void {
    this.ticketRequestSequence++;
    this.pisoSeleccionadoId.set(pisoId);
    this.areaSeleccionadaId.set('');
    this.paginaPuestos.set(1);
    this.paginaEquiposRed.set(1);
    this.tickets.set([]);
    this.totalTickets.set(0);
    this.paginaTickets.set(1);
    this.loadingTickets.set(false);
    this.error.set('');
  }

  async seleccionarArea(areaId: string): Promise<void> {
    this.areaSeleccionadaId.set(areaId);
    this.tickets.set([]);
    this.totalTickets.set(0);
    this.paginaTickets.set(1);
    this.error.set('');
    if (!areaId) {
      this.ticketRequestSequence++;
      this.loadingTickets.set(false);
      return;
    }

    await this.cargarTicketsArea(1);
  }

  async cargarTicketsArea(page = 1): Promise<void> {
    const areaId = this.areaSeleccionadaId();
    const requestSequence = ++this.ticketRequestSequence;
    if (!areaId) {
      this.tickets.set([]);
      this.totalTickets.set(0);
      this.loadingTickets.set(false);
      return;
    }

    this.paginaTickets.set(page);
    this.loadingTickets.set(true);
    this.error.set('');
    try {
      const result = await this.ticketsService.buscarPorArea(areaId, {
        search: this.filtroTicketsTexto(),
        responsible: this.filtroTicketsResponsable(),
        from: this.ticketsDesde(),
        to: this.ticketsHasta(),
        state: this.filtroTicketsEstado(),
        category: this.filtroTicketsCategoria(),
        sort: this.ordenTickets(),
        page,
        pageSize: this.ticketsPorPagina,
      });
      if (requestSequence === this.ticketRequestSequence) {
        this.tickets.set(result.items);
        this.totalTickets.set(result.total);
      }
    } catch (error: unknown) {
      if (requestSequence === this.ticketRequestSequence) {
        this.error.set(
          error instanceof Error
            ? error.message
            : 'No se pudo cargar el historial de reclamos del área.',
        );
      }
    } finally {
      if (requestSequence === this.ticketRequestSequence) this.loadingTickets.set(false);
    }
  }

  limpiarFiltrosTickets(): void {
    this.filtroTicketsTexto.set('');
    this.filtroTicketsResponsable.set('');
    this.filtroTicketsEstado.set('');
    this.filtroTicketsCategoria.set('');
    this.ticketsDesde.set('');
    this.ticketsHasta.set('');
    this.ordenTickets.set('newest');
    void this.cargarTicketsArea(1);
  }

  aplicarFiltrosTickets(): void {
    void this.cargarTicketsArea(1);
  }

  paginaTicketsAnterior(): void {
    if (this.paginaTickets() > 1) void this.cargarTicketsArea(this.paginaTickets() - 1);
  }

  paginaTicketsSiguiente(): void {
    if (this.paginaTickets() < this.totalPaginasTickets()) {
      void this.cargarTicketsArea(this.paginaTickets() + 1);
    }
  }

  limpiarFiltrosActivos(): void {
    this.busquedaActivos.set('');
    this.tipoComponente.set('');
    this.tipoEquipoRed.set('');
    this.paginaPuestos.set(1);
    this.paginaEquiposRed.set(1);
  }

  reiniciarPaginas(): void {
    this.paginaPuestos.set(1);
    this.paginaEquiposRed.set(1);
  }

  private normalizar(value: string): string {
    return value
      .trim()
      .toLocaleLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }
}

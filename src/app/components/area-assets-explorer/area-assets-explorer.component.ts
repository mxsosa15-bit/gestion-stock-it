import { CommonModule, DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
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
export class AreaAssetsExplorerComponent {
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
  readonly tickets = signal<SupportTicket[]>([]);
  readonly loadingTickets = signal(false);
  readonly error = signal('');
  readonly areasDelPiso = computed(() => {
    const pisoId = this.pisoSeleccionadoId();
    return pisoId ? this.areas().filter((area) => area.pisoId === pisoId) : [];
  });
  readonly areaSeleccionada = computed(
    () => this.areas().find((area) => area.id === this.areaSeleccionadaId()) ?? null,
  );
  readonly puestosDelArea = computed(() =>
    this.puestos().filter((puesto) => puesto.areaId === this.areaSeleccionadaId()),
  );
  readonly equiposRedDelArea = computed(() =>
    this.equiposRed().filter((equipo) => equipo.areaId === this.areaSeleccionadaId()),
  );
  readonly cantidadEquipos = computed(
    () =>
      this.puestosDelArea().length +
      this.puestosDelArea().reduce((total, puesto) => total + puesto.componentes.length, 0) +
      this.equiposRedDelArea().length,
  );

  seleccionarPiso(pisoId: string): void {
    this.ticketRequestSequence++;
    this.pisoSeleccionadoId.set(pisoId);
    this.areaSeleccionadaId.set('');
    this.tickets.set([]);
    this.loadingTickets.set(false);
    this.error.set('');
  }

  async seleccionarArea(areaId: string): Promise<void> {
    const requestSequence = ++this.ticketRequestSequence;
    this.areaSeleccionadaId.set(areaId);
    this.tickets.set([]);
    this.error.set('');
    if (!areaId) {
      this.loadingTickets.set(false);
      return;
    }

    this.loadingTickets.set(true);
    try {
      const tickets = await this.ticketsService.listarPorArea(areaId);
      if (requestSequence === this.ticketRequestSequence) this.tickets.set(tickets);
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
}

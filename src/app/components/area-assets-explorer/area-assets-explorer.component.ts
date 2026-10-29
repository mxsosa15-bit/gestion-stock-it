import { CommonModule, DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { InventoryService } from '../../services/inventory.service';
import { SupportTicket, TicketsService } from '../../services/tickets.service';

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

  readonly pisos = this.inventoryService.pisos;
  readonly areas = this.inventoryService.areas;
  readonly puestos = this.inventoryService.puestos;
  readonly equiposRed = this.inventoryService.equiposRed;
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

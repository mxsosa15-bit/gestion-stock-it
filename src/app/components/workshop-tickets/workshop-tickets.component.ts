import { CommonModule, DatePipe, isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SupportTicket, TicketsService, WorkshopReturnInput } from '../../services/tickets.service';

@Component({
  selector: 'app-workshop-tickets',
  imports: [CommonModule, DatePipe, FormsModule],
  templateUrl: './workshop-tickets.component.html',
  styleUrl: './workshop-tickets.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkshopTicketsComponent implements OnInit, OnDestroy {
  private readonly ticketsService = inject(TicketsService);
  private readonly platformId = inject(PLATFORM_ID);
  private eventSource: EventSource | null = null;
  readonly returnDrafts = signal<Record<string, WorkshopReturnInput>>({});

  readonly tickets = signal<SupportTicket[]>([]);
  readonly sedeId = input<string | null>(null);
  readonly ticketsEnSede = computed(() =>
    this.tickets().filter((ticket) => !this.sedeId() || ticket.sede_id === this.sedeId()),
  );
  readonly loading = signal(true);
  readonly busyTicketId = signal<string | null>(null);
  readonly error = signal('');
  readonly notice = signal('');

  ngOnInit(): void {
    void this.cargar();
    if (isPlatformBrowser(this.platformId)) {
      this.eventSource = new EventSource('/api/tickets/events');
      this.eventSource.addEventListener('ticket', () => void this.cargar());
      this.eventSource.onerror = () => {
        this.error.set(
          'Se perdió la conexión en tiempo real; podés actualizar la lista manualmente.',
        );
      };
      this.eventSource.onopen = () => {
        if (this.error().startsWith('Se perdió la conexión')) this.error.set('');
      };
    }
  }

  ngOnDestroy(): void {
    this.eventSource?.close();
  }

  actualizarSolucion(ticketId: string, value: string): void {
    this.actualizarDevolucion(ticketId, 'solucion', value);
  }

  actualizarDevolucion(ticketId: string, field: keyof WorkshopReturnInput, value: string): void {
    this.returnDrafts.update((drafts) => ({
      ...drafts,
      [ticketId]: { ...drafts[ticketId], [field]: value },
    }));
  }

  cambiarResultado(ticket: SupportTicket, resultadoEquipo: 'MISMO' | 'REEMPLAZO'): void {
    const transfer = ticket.taller;
    if (!transfer) return;
    this.returnDrafts.update((drafts) => ({
      ...drafts,
      [ticket.id]: {
        ...drafts[ticket.id],
        resultadoEquipo,
        equipoDevuelto:
          resultadoEquipo === 'MISMO'
            ? transfer.equipo
            : drafts[ticket.id]?.resultadoEquipo === 'MISMO'
              ? ''
              : (drafts[ticket.id]?.equipoDevuelto ?? ''),
        identificacionDevuelta:
          resultadoEquipo === 'MISMO'
            ? transfer.identificacion
            : drafts[ticket.id]?.resultadoEquipo === 'MISMO'
              ? ''
              : (drafts[ticket.id]?.identificacionDevuelta ?? ''),
        motivoReemplazo:
          resultadoEquipo === 'MISMO' ? '' : (drafts[ticket.id]?.motivoReemplazo ?? ''),
      },
    }));
  }

  async devolver(ticket: SupportTicket): Promise<void> {
    const transfer = ticket.taller;
    const draft = this.returnDrafts()[ticket.id];
    if (!transfer || transfer.estado !== 'En taller' || !draft?.solucion.trim()) {
      this.error.set('Describí el trabajo realizado antes de registrar la devolución.');
      return;
    }
    if (
      draft.resultadoEquipo === 'REEMPLAZO' &&
      (!draft.equipoDevuelto.trim() ||
        !draft.identificacionDevuelta.trim() ||
        !draft.motivoReemplazo.trim())
    ) {
      this.error.set('Completá los datos del equipo de reemplazo y el motivo del cambio.');
      return;
    }

    this.error.set('');
    this.notice.set('');
    this.busyTicketId.set(ticket.id);
    try {
      await this.ticketsService.devolverDesdeTaller(ticket.id, transfer.id, {
        ...draft,
        solucion: draft.solucion.trim(),
        equipoDevuelto:
          draft.resultadoEquipo === 'MISMO' ? transfer.equipo : draft.equipoDevuelto.trim(),
        identificacionDevuelta:
          draft.resultadoEquipo === 'MISMO'
            ? transfer.identificacion
            : draft.identificacionDevuelta.trim(),
        motivoReemplazo: draft.motivoReemplazo.trim(),
      });
      this.tickets.update((tickets) => tickets.filter((item) => item.id !== ticket.id));
      this.returnDrafts.update((drafts) => {
        const remaining = { ...drafts };
        delete remaining[ticket.id];
        return remaining;
      });
      this.notice.set(`Devolución registrada y reclamo “${ticket.titulo}” terminado.`);
    } catch (error: unknown) {
      this.error.set(
        error instanceof Error ? error.message : 'No se pudo registrar la devolución.',
      );
    } finally {
      this.busyTicketId.set(null);
    }
  }

  reintentar(): void {
    void this.cargar();
  }

  private async cargar(): Promise<void> {
    try {
      const tickets = await this.ticketsService.listarTaller();
      this.tickets.set(tickets);
      this.inicializarDevoluciones(tickets);
      this.error.set('');
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'No se pudo cargar el taller.');
    } finally {
      this.loading.set(false);
    }
  }

  private inicializarDevoluciones(tickets: SupportTicket[]): void {
    this.returnDrafts.update((drafts) => {
      const next = { ...drafts };
      for (const ticket of tickets) {
        const transfer = ticket.taller;
        if (!transfer || next[ticket.id]) continue;
        next[ticket.id] = {
          solucion: '',
          resultadoEquipo: 'MISMO',
          equipoDevuelto: transfer.equipo,
          identificacionDevuelta: transfer.identificacion,
          motivoReemplazo: '',
        };
      }
      return next;
    });
  }
}

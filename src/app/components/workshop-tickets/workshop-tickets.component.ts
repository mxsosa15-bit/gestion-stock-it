import { CommonModule, DatePipe, isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  inject,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SupportTicket, TicketsService } from '../../services/tickets.service';

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
  readonly solutions = signal<Record<string, string>>({});

  readonly tickets = signal<SupportTicket[]>([]);
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
        this.error.set('Se perdió la conexión en tiempo real; podés actualizar la lista manualmente.');
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
    this.solutions.update((values) => ({ ...values, [ticketId]: value }));
  }

  async devolver(ticket: SupportTicket): Promise<void> {
    const transfer = ticket.taller;
    const solucion = this.solutions()[ticket.id]?.trim() ?? '';
    if (!transfer || transfer.estado !== 'En taller' || !solucion) {
      this.error.set('Describí el trabajo realizado antes de registrar la devolución.');
      return;
    }

    this.error.set('');
    this.notice.set('');
    this.busyTicketId.set(ticket.id);
    try {
      await this.ticketsService.devolverDesdeTaller(ticket.id, transfer.id, solucion);
      this.tickets.update((tickets) => tickets.filter((item) => item.id !== ticket.id));
      this.solutions.update((values) => {
        const remaining = { ...values };
        delete remaining[ticket.id];
        return remaining;
      });
      this.notice.set(`Devolución registrada y reclamo “${ticket.titulo}” terminado.`);
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'No se pudo registrar la devolución.');
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
      this.error.set('');
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'No se pudo cargar el taller.');
    } finally {
      this.loading.set(false);
    }
  }
}

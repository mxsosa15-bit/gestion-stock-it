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
import type { Chart } from 'chart.js';
import { TICKET_CATEGORIES, type TicketCategory } from '../../../shared/tickets';
import { InventoryService } from '../../services/inventory.service';
import { SupportTicket, TicketsService } from '../../services/tickets.service';

interface TicketEvent {
  id: string;
  action: 'created' | 'updated' | 'workshop';
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

@Component({
  selector: 'app-operations-dashboard',
  imports: [CommonModule, DatePipe],
  templateUrl: './operations-dashboard.component.html',
  styleUrl: './operations-dashboard.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OperationsDashboardComponent implements OnInit, AfterViewInit, OnDestroy {
  private readonly ticketsService = inject(TicketsService);
  private readonly inventoryService = inject(InventoryService);
  private readonly platformId = inject(PLATFORM_ID);
  private eventSource: EventSource | null = null;
  private categoryChart: Chart<'doughnut', number[], string> | null = null;
  private resolvedChart: Chart<'bar', number[], string> | null = null;
  private chartsReady = false;
  private requestSequence = 0;
  private arrivalTimer?: ReturnType<typeof setTimeout>;

  @ViewChild('categoryCanvas') private categoryCanvas?: ElementRef<HTMLCanvasElement>;
  @ViewChild('resolvedCanvas') private resolvedCanvas?: ElementRef<HTMLCanvasElement>;

  readonly tickets = signal<SupportTicket[]>([]);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly liveConnected = signal(false);
  readonly newestTicketId = signal('');
  readonly categories = TICKET_CATEGORIES;
  readonly todayLabel = new Intl.DateTimeFormat('es-AR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date());
  readonly activeTickets = computed(() =>
    this.tickets().filter((ticket) => ticket.estado !== 'Terminado'),
  );
  readonly workshopEquipment = computed(
    () =>
      this.inventoryService
        .componentesRetirados()
        .filter((component) => component.estado === 'REPARACION').length,
  );
  readonly pendingApprovals = computed(
    () => this.tickets().filter((ticket) => ticket.taller?.estado === 'Pendiente').length,
  );
  readonly lowStockItems = computed(() =>
    this.inventoryService
      .stock()
      .filter((item) => item.cantidadDisponible <= item.stockMinimo)
      .sort((a, b) => a.cantidadDisponible - b.cantidadDisponible),
  );
  readonly latestTickets = computed(() =>
    [...this.tickets()]
      .sort((a, b) => new Date(b.fecha_creacion).getTime() - new Date(a.fecha_creacion).getTime())
      .slice(0, 5),
  );

  ngOnInit(): void {
    void this.cargarTickets(true);
    if (isPlatformBrowser(this.platformId)) this.conectarEventos();
  }

  ngAfterViewInit(): void {
    if (isPlatformBrowser(this.platformId)) void this.inicializarGraficos();
  }

  ngOnDestroy(): void {
    this.eventSource?.close();
    if (this.arrivalTimer) clearTimeout(this.arrivalTimer);
    this.categoryChart?.destroy();
    this.resolvedChart?.destroy();
  }

  cantidadCategoria(category: TicketCategory): number {
    return this.activeTickets().filter((ticket) => ticket.categoria === category).length;
  }

  categoryColor(index: number): string {
    return CATEGORY_COLORS[index] ?? CATEGORY_COLORS[CATEGORY_COLORS.length - 1]!;
  }

  reintentar(): void {
    void this.cargarTickets(true);
  }

  private async inicializarGraficos(): Promise<void> {
    const categoryCanvas = this.categoryCanvas?.nativeElement;
    const resolvedCanvas = this.resolvedCanvas?.nativeElement;
    if (!categoryCanvas || !resolvedCanvas) return;

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

    this.resolvedChart = new ChartJS(resolvedCanvas, {
      type: 'bar',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Reclamos resueltos',
            data: [],
            backgroundColor: '#3867f4',
            hoverBackgroundColor: '#244fd2',
            borderRadius: 7,
            maxBarThickness: 34,
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
    if (!this.chartsReady || !this.categoryChart || !this.resolvedChart) return;

    this.categoryChart.data.datasets[0]!.data = this.categories.map((category) =>
      this.cantidadCategoria(category),
    );
    this.categoryChart.update();

    const week = this.ultimosSieteDias();
    this.resolvedChart.data.labels = week.map((day) => day.label);
    this.resolvedChart.data.datasets[0]!.data = week.map(
      (day) =>
        this.tickets().filter(
          (ticket) =>
            ticket.estado === 'Terminado' &&
            ticket.fecha_resolucion !== null &&
            this.fechaLocal(ticket.fecha_resolucion) === day.key,
        ).length,
    );
    this.resolvedChart.update();
  }

  private ultimosSieteDias(): { key: string; label: string }[] {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(today);
      date.setDate(today.getDate() - (6 - index));
      return {
        key: this.fechaLocal(date.toISOString()),
        label: new Intl.DateTimeFormat('es-AR', { weekday: 'short' }).format(date),
      };
    });
  }

  private fechaLocal(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
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
      const tickets = await this.ticketsService.listar();
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
}

import { CommonModule, DatePipe, isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../services/auth.service';
import {
  AffectedWorkstation,
  SupportTicket,
  TicketState,
  TicketsService,
  WorkshopTransferInput,
} from '../../services/tickets.service';
import { TICKET_CATEGORIES, type TicketCategory } from '../../../shared/tickets';

interface TicketEvent {
  id: string;
  action: 'created' | 'updated' | 'workshop';
}

const TICKET_STATES: readonly TicketState[] = ['Abierto', 'En proceso', 'Terminado'];

@Component({
  selector: 'app-support-tickets',
  imports: [CommonModule, FormsModule, DatePipe],
  templateUrl: './support-tickets.component.html',
  styleUrl: './support-tickets.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SupportTicketsComponent implements OnInit, OnDestroy {
  private readonly ticketsService = inject(TicketsService);
  private readonly platformId = inject(PLATFORM_ID);
  private eventSource: EventSource | null = null;
  private toastTimer?: ReturnType<typeof setTimeout>;

  readonly authService = inject(AuthService);
  readonly loading = signal(false);
  readonly sending = signal(false);
  readonly busyTicketId = signal<string | null>(null);
  readonly error = signal('');
  readonly notice = signal('');
  readonly liveConnected = signal(false);
  readonly titulo = signal('');
  readonly descripcion = signal('');
  readonly categoria = signal<TicketCategory>('Otros');
  readonly puestoAfectadoId = signal('');
  readonly puestosAfectados = signal<AffectedWorkstation[]>([]);
  readonly puestosLoading = signal(false);
  readonly puestosError = signal('');
  readonly drafts = signal<Record<string, string>>({});
  readonly workshopDrafts = signal<Record<string, WorkshopTransferInput>>({});
  readonly workshopTicketId = signal<string | null>(null);
  readonly workshopDecisionId = signal<string | null>(null);
  readonly workshopReason = signal('');
  readonly workshopVerified = signal<Record<string, boolean>>({});
  readonly resolvingTicketId = signal<string | null>(null);
  readonly completedVisible = signal(false);
  readonly tickets = signal<SupportTicket[]>([]);
  readonly categorias = TICKET_CATEGORIES;
  readonly estados = TICKET_STATES;
  readonly filtroEstado = signal<'Todos' | TicketState>('Todos');
  readonly filtroCategoria = signal<'Todas' | TicketCategory>('Todas');
  readonly fechaDesde = signal('');
  readonly fechaHasta = signal('');

  readonly isRequester = computed(() => this.authService.user()?.role === 'solicitante');
  readonly filteredTickets = computed(() =>
    this.tickets().filter((ticket) => {
      if (this.filtroEstado() !== 'Todos' && ticket.estado !== this.filtroEstado()) return false;
      if (this.filtroCategoria() !== 'Todas' && ticket.categoria !== this.filtroCategoria()) {
        return false;
      }
      const ticketDate = this.fechaLocal(ticket.fecha_creacion);
      if (this.fechaDesde() && ticketDate < this.fechaDesde()) return false;
      if (this.fechaHasta() && ticketDate > this.fechaHasta()) return false;
      return true;
    }),
  );
  readonly activeTickets = computed(() =>
    this.filteredTickets().filter((ticket) => ticket.estado !== 'Terminado'),
  );
  readonly completedTickets = computed(() =>
    this.filteredTickets().filter((ticket) => ticket.estado === 'Terminado'),
  );

  ngOnInit(): void {
    if (isPlatformBrowser(this.platformId)) this.conectarEventos();
    void this.cargarTickets();
    if (this.isRequester()) void this.cargarPuestosAfectados();
  }

  ngOnDestroy(): void {
    this.eventSource?.close();
    if (this.toastTimer) clearTimeout(this.toastTimer);
  }

  async crearReclamo(): Promise<void> {
    const titulo = this.titulo().trim();
    const descripcion = this.descripcion().trim();
    if (!titulo || !descripcion || !this.puestoAfectadoId()) {
      this.error.set('Completá el asunto, seleccioná el puesto afectado y describí el problema.');
      return;
    }
    this.error.set('');
    this.notice.set('');
    this.sending.set(true);
    try {
      const creado = await this.ticketsService.crear(
        titulo,
        descripcion,
        this.categoria(),
        this.puestoAfectadoId(),
      );
      this.tickets.update((tickets) => [
        creado,
        ...tickets.filter((item) => item.id !== creado.id),
      ]);
      this.titulo.set('');
      this.descripcion.set('');
      this.categoria.set('Otros');
      this.puestoAfectadoId.set('');
      this.mostrarAviso('El reclamo se envió al equipo de soporte.');
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'No se pudo enviar el reclamo.');
    } finally {
      this.sending.set(false);
    }
  }

  async ponerEnProceso(ticket: SupportTicket): Promise<void> {
    await this.cambiarEstado(ticket, 'En proceso');
  }

  abrirResolucion(ticket: SupportTicket): void {
    this.resolvingTicketId.set(ticket.id);
    this.error.set('');
  }

  actualizarSolucion(ticketId: string, value: string): void {
    this.drafts.update((drafts) => ({ ...drafts, [ticketId]: value }));
  }

  actualizarSolucionDesdeEvento(ticketId: string, event: Event): void {
    const textarea = event.target;
    if (textarea instanceof HTMLTextAreaElement) {
      this.actualizarSolucion(ticketId, textarea.value);
    }
  }

  marcarEquipoVerificado(transferId: string, event: Event): void {
    const checkbox = event.target;
    if (checkbox instanceof HTMLInputElement) {
      this.workshopVerified.update((verified) => ({
        ...verified,
        [transferId]: checkbox.checked,
      }));
    }
  }

  async terminar(ticket: SupportTicket): Promise<void> {
    const solucion = this.drafts()[ticket.id]?.trim() ?? '';
    if (!solucion) {
      this.error.set('Describí la solución o el trabajo realizado antes de terminar el reclamo.');
      return;
    }
    await this.cambiarEstado(ticket, 'Terminado', solucion);
  }

  abrirDerivacion(ticket: SupportTicket): void {
    this.workshopTicketId.set(ticket.id);
    this.workshopDrafts.update((drafts) => ({
      ...drafts,
      [ticket.id]: drafts[ticket.id] ?? { equipo: '', identificacion: '', detalle: '' },
    }));
    this.error.set('');
  }

  actualizarDerivacion(ticketId: string, field: keyof WorkshopTransferInput, value: string): void {
    this.workshopDrafts.update((drafts) => ({
      ...drafts,
      [ticketId]: { ...drafts[ticketId], [field]: value },
    }));
  }

  async enviarAlTaller(ticket: SupportTicket): Promise<void> {
    const transfer = this.workshopDrafts()[ticket.id];
    if (!transfer?.equipo.trim() || !transfer.identificacion.trim() || !transfer.detalle.trim()) {
      this.error.set('Completá el equipo, su identificador y el motivo de derivación.');
      return;
    }
    this.error.set('');
    this.busyTicketId.set(ticket.id);
    try {
      const updated = await this.ticketsService.derivarATaller(ticket.id, transfer);
      this.reemplazarTicket(updated);
      this.workshopTicketId.set(null);
      this.mostrarAviso('La derivación quedó pendiente de aprobación del solicitante.');
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'No se pudo derivar al taller.');
    } finally {
      this.busyTicketId.set(null);
    }
  }

  abrirRechazo(transferId: string): void {
    this.workshopDecisionId.set(transferId);
    this.workshopReason.set('');
  }

  async aprobarDerivacion(ticket: SupportTicket): Promise<void> {
    const transfer = ticket.taller;
    if (!transfer || !this.workshopVerified()[transfer.id]) {
      this.error.set('Confirmá que verificaste el equipo y su identificación antes de aprobar.');
      return;
    }
    await this.resolverDerivacion(ticket, transfer.id, true);
  }

  async rechazarDerivacion(ticket: SupportTicket): Promise<void> {
    const transfer = ticket.taller;
    const motivo = this.workshopReason().trim();
    if (!transfer || !motivo) {
      this.error.set('Indicá por qué no reconocés el equipo o la derivación.');
      return;
    }
    await this.resolverDerivacion(ticket, transfer.id, false, motivo);
  }

  indiceEstado(estado: TicketState): number {
    return TICKET_STATES.indexOf(estado);
  }

  exportarReporte(): void {
    const headers = [
      'Fecha',
      'Estado',
      'Categoría',
      'Asunto',
      'Descripción',
      'Solicitante',
      'Área',
      'Puesto o usuario afectado',
      'Solución',
      'Equipo enviado al taller',
      'Identificación',
      'Estado de aprobación',
    ];
    const rows = this.filteredTickets().map((ticket) => [
      ticket.fecha_creacion,
      ticket.estado,
      ticket.categoria,
      ticket.titulo,
      ticket.descripcion,
      ticket.usuario_nombre,
      ticket.area_nombre ?? '',
      ticket.nombre_afectado ?? '',
      ticket.solucion ?? '',
      ticket.taller?.equipo ?? '',
      ticket.taller?.identificacion ?? '',
      ticket.taller?.estado ?? '',
    ]);
    const csv = [headers, ...rows]
      .map((row) => row.map((value) => this.celdaCsv(value)).join(','))
      .join('\r\n');
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'reclamos-soporte.csv';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  private async resolverDerivacion(
    ticket: SupportTicket,
    transferId: string,
    aprobar: boolean,
    motivo?: string,
  ): Promise<void> {
    this.error.set('');
    this.busyTicketId.set(ticket.id);
    try {
      const updated = await this.ticketsService.resolverDerivacion(
        ticket.id,
        transferId,
        aprobar,
        motivo,
      );
      this.reemplazarTicket(updated);
      this.workshopDecisionId.set(null);
      this.workshopVerified.update((verified) => ({ ...verified, [transferId]: false }));
      this.mostrarAviso(
        aprobar
          ? 'La aprobación quedó registrada con tu cuenta y la fecha del servidor.'
          : 'La derivación fue rechazada y quedó registrada.',
      );
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'No se pudo registrar la decisión.');
    } finally {
      this.busyTicketId.set(null);
    }
  }

  private async cambiarEstado(
    ticket: SupportTicket,
    estado: Exclude<TicketState, 'Abierto'>,
    solucion?: string,
  ): Promise<void> {
    this.error.set('');
    this.busyTicketId.set(ticket.id);
    try {
      const actualizado = await this.ticketsService.actualizar(ticket.id, estado, solucion);
      this.reemplazarTicket(actualizado);
      this.resolvingTicketId.set(null);
      this.mostrarAviso(
        estado === 'Terminado' ? 'Reclamo terminado.' : 'Reclamo puesto en proceso.',
      );
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'No se pudo actualizar el reclamo.');
    } finally {
      this.busyTicketId.set(null);
    }
  }

  private conectarEventos(): void {
    this.eventSource = new EventSource('/api/tickets/events');
    this.eventSource.onopen = () => this.liveConnected.set(true);
    this.eventSource.onerror = () => this.liveConnected.set(false);
    this.eventSource.addEventListener('ticket', (event: MessageEvent<string>) => {
      let payload: TicketEvent;
      try {
        payload = JSON.parse(event.data) as TicketEvent;
      } catch (error: unknown) {
        console.error('No se pudo interpretar el aviso de tickets en tiempo real.', error);
        return;
      }
      void this.actualizarDesdeEvento(payload);
    });
  }

  private async actualizarDesdeEvento(event: TicketEvent): Promise<void> {
    try {
      const tickets = this.isRequester()
        ? await this.ticketsService.listarMios()
        : await this.ticketsService.listar();
      this.tickets.set(tickets);
      const ticket = tickets.find((item) => item.id === event.id);
      if (event.action === 'created' && ticket && !this.isRequester()) {
        this.mostrarAviso(`Nuevo reclamo: ${ticket.categoria} · ${ticket.titulo}`);
      } else if (ticket && this.isRequester() && event.action !== 'created') {
        this.mostrarAviso(`Tu reclamo "${ticket.titulo}" se actualizó: ${ticket.estado}.`);
      }
    } catch (error: unknown) {
      this.error.set(
        error instanceof Error ? error.message : 'No se pudo actualizar la lista de reclamos.',
      );
    }
  }

  private async cargarTickets(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const tickets = this.isRequester()
        ? await this.ticketsService.listarMios()
        : await this.ticketsService.listar();
      this.tickets.set(tickets);
    } catch (error: unknown) {
      this.error.set(
        error instanceof Error ? error.message : 'No se pudieron cargar los reclamos.',
      );
    } finally {
      this.loading.set(false);
    }
  }

  private async cargarPuestosAfectados(): Promise<void> {
    const areaId = this.authService.user()?.areaId;
    if (!areaId) {
      this.puestosError.set('Tu cuenta no tiene un área asignada. Contactá a la administración.');
      return;
    }

    this.puestosLoading.set(true);
    this.puestosError.set('');
    try {
      this.puestosAfectados.set(await this.ticketsService.listarPuestosDelArea(areaId));
    } catch (error: unknown) {
      this.puestosError.set(
        error instanceof Error ? error.message : 'No se pudieron cargar los puestos de tu área.',
      );
    } finally {
      this.puestosLoading.set(false);
    }
  }

  private reemplazarTicket(ticket: SupportTicket): void {
    this.tickets.update((tickets) => [ticket, ...tickets.filter((item) => item.id !== ticket.id)]);
  }

  private mostrarAviso(mensaje: string): void {
    this.notice.set(mensaje);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.notice.set(''), 6_000);
  }

  private celdaCsv(value: string): string {
    const safeValue = /^[\s]*[=+\-@]/.test(value) ? `'${value}` : value;
    return `"${safeValue.replaceAll('"', '""')}"`;
  }

  private fechaLocal(value: string): string {
    const date = new Date(value);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
}

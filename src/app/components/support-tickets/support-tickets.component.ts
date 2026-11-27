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
  TicketDetailsInput,
  TicketFilters,
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
  private requestSequence = 0;
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
  readonly ticketEnEdicionId = signal<string | null>(null);
  readonly edicionTicket = signal<TicketDetailsInput | null>(null);
  readonly categorias = TICKET_CATEGORIES;
  readonly estados = TICKET_STATES;
  readonly filtroEstado = signal<'Todos' | TicketState>('Todos');
  readonly filtroCategoria = signal<'Todas' | TicketCategory>('Todas');
  readonly fechaDesde = signal('');
  readonly fechaHasta = signal('');
  readonly filtroTexto = signal('');
  readonly filtroSede = signal('');
  readonly filtroArea = signal('');
  readonly filtroResponsable = signal('');
  readonly orden = signal<'newest' | 'oldest'>('newest');
  readonly pagina = signal(1);
  readonly paginaTamano = 20;
  readonly totalResultados = signal(0);
  readonly totalPaginas = computed(() =>
    Math.max(1, Math.ceil(this.totalResultados() / this.paginaTamano)),
  );

  readonly isRequester = computed(() => this.authService.user()?.role === 'solicitante');
  readonly filteredTickets = computed(() => this.tickets());
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
    if (this.sending()) return;
    const titulo = this.titulo().trim();
    const descripcion = this.descripcion().trim();
    if (!titulo || !descripcion || !this.puestoAfectadoId()) {
      this.error.set('Completá el asunto, seleccioná el puesto afectado y describí el problema.');
      return;
    }
    const puesto = this.puestosAfectados().find((item) => item.id === this.puestoAfectadoId());
    if (
      !window.confirm(
        `¿Confirmás enviar este reclamo?\n\nAsunto: ${titulo}\nCategoría: ${this.categoria()}\nPuesto afectado: ${puesto?.nombrePuesto ?? 'No identificado'} · Usuario: ${puesto?.usuarioAsignado ?? 'No identificado'}\nDescripción: ${descripcion}`,
      )
    ) return;
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
      await this.cargarTickets(false, 1);
      this.mostrarAviso('El reclamo se envió al equipo de soporte.');
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'No se pudo enviar el reclamo.');
    } finally {
      this.sending.set(false);
    }
  }

  iniciarEdicionTicket(ticket: SupportTicket): void {
    if (!this.isRequester() || ticket.estado !== 'Abierto' || ticket.taller) return;
    this.ticketEnEdicionId.set(ticket.id);
    this.edicionTicket.set({
      titulo: ticket.titulo,
      descripcion: ticket.descripcion,
      categoria: ticket.categoria,
    });
    this.error.set('');
  }

  actualizarCampoEdicionTicket(campo: keyof TicketDetailsInput, value: string): void {
    this.edicionTicket.update((details) => {
      if (!details) return null;
      if (campo === 'categoria') {
        const categoria = this.categorias.find((item) => item === value);
        return categoria ? { ...details, categoria } : details;
      }
      return { ...details, [campo]: value };
    });
  }

  cancelarEdicionTicket(): void {
    if (this.busyTicketId() === this.ticketEnEdicionId()) return;
    this.ticketEnEdicionId.set(null);
    this.edicionTicket.set(null);
    this.error.set('');
  }

  async guardarEdicionTicket(ticket: SupportTicket): Promise<void> {
    const details = this.edicionTicket();
    if (
      !details ||
      ticket.id !== this.ticketEnEdicionId() ||
      !this.isRequester() ||
      ticket.estado !== 'Abierto' ||
      ticket.taller ||
      this.busyTicketId() === ticket.id
    ) {
      return;
    }
    if (!details.titulo.trim() || !details.descripcion.trim()) {
      this.error.set('Completá el asunto y el detalle del reclamo.');
      return;
    }
    const resumen = [
      `Asunto: ${ticket.titulo} → ${details.titulo.trim()}`,
      `Categoría: ${ticket.categoria} → ${details.categoria}`,
      `Descripción anterior: ${ticket.descripcion}`,
      `Descripción nueva: ${details.descripcion.trim()}`,
    ].join('\n');
    if (!window.confirm(`¿Confirmás modificar el reclamo ${ticket.id}?\n\n${resumen}`)) return;
    this.error.set('');
    this.busyTicketId.set(ticket.id);
    try {
      const updated = await this.ticketsService.editarDetalles(ticket.id, {
        ...details,
        titulo: details.titulo.trim(),
        descripcion: details.descripcion.trim(),
      });
      this.reemplazarTicket(updated);
      this.ticketEnEdicionId.set(null);
      this.edicionTicket.set(null);
      await this.cargarTickets(false);
      this.mostrarAviso('Se actualizaron los datos del reclamo.');
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'No se pudo editar el reclamo.');
    } finally {
      this.busyTicketId.set(null);
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
    if (this.busyTicketId() === ticket.id) return;
    const transfer = this.workshopDrafts()[ticket.id];
    if (!transfer?.equipo.trim() || !transfer.identificacion.trim() || !transfer.detalle.trim()) {
      this.error.set('Completá el equipo, su identificador y el motivo de derivación.');
      return;
    }
    if (
      !window.confirm(
        `¿Confirmás solicitar la derivación al taller?\n\nReclamo: ${ticket.titulo}\nEquipo: ${transfer.equipo.trim()}\nSerie o patrimonio: ${transfer.identificacion.trim()}\nOrigen: ${ticket.sede_nombre ?? 'Sede no identificada'} · ${ticket.area_nombre ?? 'Área no identificada'}\nDestino: Taller de Casa Central\nMotivo: ${transfer.detalle.trim()}\nSe solicitará la aprobación del usuario antes del traslado.`,
      )
    ) return;
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
      'Sede de origen',
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
      'Resultado del taller',
      'Equipo entregado',
      'Identificación entregada',
      'Motivo del reemplazo',
    ];
    const rows = this.filteredTickets().map((ticket) => [
      ticket.fecha_creacion,
      ticket.sede_nombre ?? '',
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
      ticket.taller?.resultado_equipo ?? '',
      ticket.taller?.equipo_devuelto ?? '',
      ticket.taller?.identificacion_devuelta ?? '',
      ticket.taller?.motivo_reemplazo ?? '',
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
    if (this.busyTicketId() === ticket.id) return;
    const transfer = ticket.taller;
    if (!transfer) return;
    const decision = aprobar ? 'aprobar la derivación y autorizar el traslado' : 'rechazar la derivación';
    if (!aprobar) {
      const detalle = [
        `Reclamo: ${ticket.titulo}`,
        `Equipo: ${transfer.equipo}`,
        `Serie o patrimonio: ${transfer.identificacion}`,
        `Acción: ${decision}`,
        ...(motivo ? [`Motivo del rechazo: ${motivo}`] : []),
      ].join('\n');
      if (!window.confirm(`¿Confirmás esta decisión?\n\n${detalle}`)) return;
    }
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
      await this.cargarTickets(false);
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
    if (this.busyTicketId() === ticket.id) return;
    if (
      !window.confirm(
        `¿Confirmás cambiar el estado del reclamo?\n\nReclamo: ${ticket.titulo}\nEstado actual: ${ticket.estado}\nEstado nuevo: ${estado}${solucion ? `\nSolución: ${solucion}` : ''}`,
      )
    ) return;
    this.error.set('');
    this.busyTicketId.set(ticket.id);
    try {
      const actualizado = await this.ticketsService.actualizar(ticket.id, estado, solucion);
      this.reemplazarTicket(actualizado);
      await this.cargarTickets(false);
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
      await this.cargarTickets(false);
      const ticket = this.tickets().find((item) => item.id === event.id);
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

  private async cargarTickets(showLoading = true, page = this.pagina()): Promise<void> {
    const requestSequence = ++this.requestSequence;
    this.pagina.set(page);
    if (showLoading) this.loading.set(true);
    this.error.set('');
    try {
      const filters = this.filtrosTickets(page);
      const result = this.isRequester()
        ? await this.ticketsService.buscarMios(filters)
        : await this.ticketsService.buscar(filters);
      if (requestSequence !== this.requestSequence) return;
      this.tickets.set(result.items);
      this.totalResultados.set(result.total);
    } catch (error: unknown) {
      if (requestSequence === this.requestSequence) {
        this.error.set(
          error instanceof Error ? error.message : 'No se pudieron cargar los reclamos.',
        );
      }
    } finally {
      if (requestSequence === this.requestSequence) this.loading.set(false);
    }
  }

  aplicarFiltros(): void {
    void this.cargarTickets(true, 1);
  }

  limpiarFiltros(): void {
    this.filtroTexto.set('');
    this.filtroSede.set('');
    this.filtroArea.set('');
    this.filtroResponsable.set('');
    this.filtroEstado.set('Todos');
    this.filtroCategoria.set('Todas');
    this.fechaDesde.set('');
    this.fechaHasta.set('');
    this.orden.set('newest');
    this.aplicarFiltros();
  }

  paginaAnterior(): void {
    if (this.pagina() > 1) void this.cargarTickets(true, this.pagina() - 1);
  }

  paginaSiguiente(): void {
    if (this.pagina() < this.totalPaginas()) {
      void this.cargarTickets(true, this.pagina() + 1);
    }
  }

  private filtrosTickets(page: number): TicketFilters {
    return {
      search: this.filtroTexto(),
      site: this.isRequester() ? '' : this.filtroSede(),
      area: this.isRequester() ? '' : this.filtroArea(),
      responsible: this.isRequester() ? '' : this.filtroResponsable(),
      from: this.fechaDesde(),
      to: this.fechaHasta(),
      state: this.filtroEstado() === 'Todos' ? '' : this.filtroEstado(),
      category: this.filtroCategoria() === 'Todas' ? '' : this.filtroCategoria(),
      sort: this.orden(),
      page,
      pageSize: this.paginaTamano,
    };
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

}

import { CommonModule } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  OperatorAuditFilters,
  OperatorAuditService,
  type OperatorAuditEvent,
  type OperatorAuditSummary,
} from '../../services/operator-audit.service';

@Component({
  selector: 'app-operator-audit',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './operator-audit.component.html',
  styleUrl: './operator-audit.component.scss',
})
export class OperatorAuditComponent implements OnInit {
  private requestSequence = 0;
  private readonly auditService = inject(OperatorAuditService);
  readonly desde = signal('');
  readonly hasta = signal('');
  readonly operadorId = signal('');
  readonly modulo = signal('');
  readonly accion = signal('');
  readonly busqueda = signal('');
  readonly orden = signal<'newest' | 'oldest'>('newest');
  readonly pagina = signal(1);
  readonly paginaTamano = 50;
  readonly totalEventos = signal(0);
  readonly operadores = signal<OperatorAuditSummary[]>([]);
  readonly operadoresDisponibles = signal<
    Awaited<ReturnType<OperatorAuditService['listar']>>['operators']
  >([]);
  readonly eventos = signal<OperatorAuditEvent[]>([]);
  readonly cargando = signal(false);
  readonly error = signal('');
  readonly totalPaginas = computed(() =>
    Math.max(1, Math.ceil(this.totalEventos() / this.paginaTamano)),
  );

  ngOnInit(): void {
    void this.cargar();
  }

  async cargar(page = 1): Promise<void> {
    const requestSequence = ++this.requestSequence;
    this.pagina.set(page);
    this.cargando.set(true);
    this.error.set('');
    try {
      const filters: OperatorAuditFilters = {
        from: this.desde(),
        to: this.hasta(),
        actorId: this.operadorId(),
        module: this.modulo(),
        action: this.accion(),
        search: this.busqueda(),
        sort: this.orden(),
        page,
        pageSize: this.paginaTamano,
      };
      const result = await this.auditService.listar(filters);
      if (requestSequence === this.requestSequence) {
        this.operadoresDisponibles.set(result.operators);
        this.operadores.set(result.summary);
        this.eventos.set(result.events);
        this.totalEventos.set(result.total);
      }
    } catch (error: unknown) {
      if (requestSequence === this.requestSequence) {
        this.error.set(
          error instanceof Error ? error.message : 'No se pudo cargar la auditoría de operadores.',
        );
      }
    } finally {
      if (requestSequence === this.requestSequence) this.cargando.set(false);
    }
  }

  totalAcciones(): number {
    return this.operadores().reduce((total, operador) => total + operador.eventCount, 0);
  }

  resultado(evento: OperatorAuditEvent): string {
    const result = evento.details['resultado'];
    if (result === 'exitoso' || result === 'procesado') return 'Exitoso';
    if (result === 'fallido') return 'Fallido';
    if (result === 'ya_procesado') return 'Reintento procesado';
    if (result === 'resultado_incierto') return 'Incierto; verificar';
    return 'Registrado';
  }

  detalle(evento: OperatorAuditEvent): string {
    const details = Object.fromEntries(
      Object.entries(evento.details).filter(
        ([key]) => key !== 'resultado',
      ),
    );
    return Object.keys(details).length > 0 ? JSON.stringify(details) : '—';
  }

  limpiarFiltros(): void {
    this.desde.set('');
    this.hasta.set('');
    this.operadorId.set('');
    this.modulo.set('');
    this.accion.set('');
    this.busqueda.set('');
    this.orden.set('newest');
    void this.cargar(1);
  }

  paginaAnterior(): void {
    if (this.pagina() > 1) void this.cargar(this.pagina() - 1);
  }

  paginaSiguiente(): void {
    if (this.pagina() < this.totalPaginas()) void this.cargar(this.pagina() + 1);
  }
}

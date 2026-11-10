import { CommonModule } from '@angular/common';
import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  OperatorAuditService,
  type OperatorAuditEvent,
  type OperatorTaskSummary,
} from '../../services/operator-audit.service';

function formatDateInput(date: Date): string {
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localDate.toISOString().slice(0, 10);
}

@Component({
  selector: 'app-operator-audit',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './operator-audit.component.html',
  styleUrl: './operator-audit.component.scss',
})
export class OperatorAuditComponent implements OnInit {
  private readonly auditService = inject(OperatorAuditService);
  readonly desde = signal(formatDateInput(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000)));
  readonly hasta = signal(formatDateInput(new Date()));
  readonly operadorId = signal('');
  readonly operadores = signal<OperatorTaskSummary[]>([]);
  readonly operadoresDisponibles = signal<
    Awaited<ReturnType<OperatorAuditService['listar']>>['operators']
  >([]);
  readonly eventos = signal<OperatorAuditEvent[]>([]);
  readonly cargando = signal(false);
  readonly error = signal('');

  ngOnInit(): void {
    void this.cargar();
  }

  async cargar(): Promise<void> {
    this.cargando.set(true);
    this.error.set('');
    try {
      const result = await this.auditService.listar(this.desde(), this.hasta(), this.operadorId());
      this.operadoresDisponibles.set(result.operators);
      this.operadores.set(result.summary);
      this.eventos.set(result.events);
    } catch (error: unknown) {
      this.error.set(
        error instanceof Error ? error.message : 'No se pudo cargar la auditoría de operadores.',
      );
    } finally {
      this.cargando.set(false);
    }
  }

  totalTareas(): number {
    return this.operadores().reduce((total, operador) => total + operador.taskCount, 0);
  }
}

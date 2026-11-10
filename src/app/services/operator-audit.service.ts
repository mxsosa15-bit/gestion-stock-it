import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface AuditedOperator {
  id: string;
  username: string;
  role: 'admin' | 'operator';
}

export interface OperatorTaskSummary {
  actorId: string;
  username: string;
  role: 'admin' | 'operator';
  taskCount: number;
}

export interface OperatorAuditEvent {
  id: string;
  actorId: string;
  actorUsername: string;
  action: string;
  entityType: string;
  entityId: string | null;
  entityName: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface OperatorAuditResponse {
  operators: AuditedOperator[];
  summary: OperatorTaskSummary[];
  events: OperatorAuditEvent[];
}

@Injectable({ providedIn: 'root' })
export class OperatorAuditService {
  private readonly http = inject(HttpClient);

  async listar(from: string, to: string, actorId: string): Promise<OperatorAuditResponse> {
    let params = new HttpParams();
    if (from) params = params.set('from', from);
    if (to) params = params.set('to', to);
    if (actorId) params = params.set('actorId', actorId);

    try {
      return await firstValueFrom(
        this.http.get<OperatorAuditResponse>('/api/admin/operator-audit', { params }),
      );
    } catch (error: unknown) {
      if (error instanceof HttpErrorResponse) {
        const message = error.error?.error;
        throw new Error(
          typeof message === 'string' ? message : 'No se pudo cargar la auditoría de operadores.',
        );
      }
      throw error instanceof Error
        ? error
        : new Error('No se pudo cargar la auditoría de operadores.');
    }
  }
}

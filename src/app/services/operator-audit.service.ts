import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { PagedResult } from '../models/paged-result';

export interface AuditedOperator {
  id: string;
  username: string;
  role: 'admin' | 'operator' | 'solicitante' | 'dashboard';
}

export interface OperatorAuditSummary {
  actorId: string;
  username: string;
  role: 'admin' | 'operator' | 'solicitante' | 'dashboard';
  eventCount: number;
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

export interface OperatorAuditResponse extends Omit<PagedResult<OperatorAuditEvent>, 'items'> {
  operators: AuditedOperator[];
  summary: OperatorAuditSummary[];
  events: OperatorAuditEvent[];
}

export interface OperatorAuditFilters {
  from: string;
  to: string;
  actorId: string;
  module: string;
  action: string;
  search: string;
  sort: 'newest' | 'oldest';
  page: number;
  pageSize: number;
}

@Injectable({ providedIn: 'root' })
export class OperatorAuditService {
  private readonly http = inject(HttpClient);

  async listar(filters: OperatorAuditFilters): Promise<OperatorAuditResponse> {
    let params = new HttpParams()
      .set('page', filters.page)
      .set('pageSize', filters.pageSize)
      .set('sort', filters.sort);
    if (filters.from) params = params.set('from', filters.from);
    if (filters.to) params = params.set('to', filters.to);
    if (filters.actorId) params = params.set('actorId', filters.actorId);
    if (filters.module.trim()) params = params.set('module', filters.module.trim());
    if (filters.action.trim()) params = params.set('action', filters.action.trim());
    if (filters.search.trim()) params = params.set('search', filters.search.trim());

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

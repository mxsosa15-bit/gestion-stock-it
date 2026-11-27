import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { PagedResult } from '../models/paged-result';

export type ReportId = 'inventory' | 'stock' | 'transfers' | 'tickets' | 'tasks' | 'activity';

export interface ReportFilters {
  search: string;
  site: string;
  area: string;
  operator: string;
  from: string;
  to: string;
  state: string;
  category: string;
  type: string;
  module: string;
  action: string;
  sort: 'newest' | 'oldest';
}

export interface ReportColumn {
  key: string;
  label: string;
}

export interface ReportPreview extends PagedResult<Record<string, string | number | null>> {
  title: string;
  columns: ReportColumn[];
  generatedAt: string;
  criteria: { label: string; value: string }[];
}

@Injectable({ providedIn: 'root' })
export class ReportsService {
  private readonly http = inject(HttpClient);

  async consultar(
    reportId: ReportId,
    filters: ReportFilters,
    page: number,
    pageSize: number,
  ): Promise<ReportPreview> {
    const params = this.crearParametros(filters).set('page', page).set('pageSize', pageSize);
    try {
      return await firstValueFrom(
        this.http.get<ReportPreview>(`/api/reports/${reportId}`, { params }),
      );
    } catch (error: unknown) {
      throw new Error(this.obtenerMensaje(error, 'No se pudo consultar el reporte.'));
    }
  }

  async descargarExcel(reportId: ReportId, filters: ReportFilters): Promise<Blob> {
    const params = this.crearParametros(filters);
    try {
      return await firstValueFrom(
        this.http.get(`/api/reports/${reportId}/export.xlsx`, {
          params,
          responseType: 'blob',
        }),
      );
    } catch (error: unknown) {
      throw new Error(this.obtenerMensaje(error, 'No se pudo generar el archivo Excel.'));
    }
  }

  urlImpresion(reportId: ReportId, filters: ReportFilters): string {
    const query = this.crearParametros(filters).toString();
    return `/api/reports/${reportId}/print${query ? `?${query}` : ''}`;
  }

  private crearParametros(filters: ReportFilters): HttpParams {
    let params = new HttpParams().set('sort', filters.sort);
    for (const [key, value] of Object.entries(filters)) {
      if (key !== 'sort' && value.trim()) params = params.set(key, value.trim());
    }
    return params;
  }

  private obtenerMensaje(error: unknown, fallback: string): string {
    if (error instanceof HttpErrorResponse) {
      if (error.error instanceof Blob) return fallback;
      const message = error.error?.error;
      return typeof message === 'string' ? message : fallback;
    }
    return error instanceof Error ? error.message : fallback;
  }
}

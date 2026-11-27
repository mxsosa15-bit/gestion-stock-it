import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { PagedResult } from '../models/paged-result';

export type OperatorTaskType =
  'Mantenimiento' | 'Instalación' | 'Configuración' | 'Relevamiento' | 'Otro';

export interface OperatorTask {
  id: string;
  sedeId: string;
  sedeNombre: string;
  operadorId: string;
  operador: string;
  tipo: OperatorTaskType;
  titulo: string;
  descripcion: string;
  duracionMinutos: number | null;
  performedAt: string;
  createdAt: string;
  areaId: string | null;
  areaNombre: string | null;
  relatedAssetType: OperatorTaskRelatedAssetType | null;
  relatedAssetId: string | null;
  observaciones: string;
}

export type OperatorTaskRelatedAssetType = 'PUESTO' | 'COMPONENTE' | 'EQUIPO_RED' | 'PATRIMONIAL';

export interface NewOperatorTask {
  sedeId: string;
  areaId: string | null;
  relatedAssetType: OperatorTaskRelatedAssetType | null;
  relatedAssetId: string | null;
  operatorId: string | null;
  performedAt: string | null;
  observaciones: string;
  tipo: OperatorTaskType;
  titulo: string;
  descripcion: string;
  duracionMinutos: number | null;
}

export interface OperatorTaskOptions {
  areas: { id: string; nombre: string }[];
  operators: { id: string; username: string }[];
  relatedAssets: {
    id: string;
    type: OperatorTaskRelatedAssetType;
    label: string;
    areaId: string | null;
  }[];
}

export interface OperatorTaskFilters {
  sedeId: string;
  areaId: string;
  search: string;
  type: string;
  operator: string;
  from: string;
  to: string;
  sort: 'newest' | 'oldest';
  page: number;
  pageSize: number;
}

@Injectable({ providedIn: 'root' })
export class OperatorTasksService {
  private readonly http = inject(HttpClient);
  readonly tasks = signal<OperatorTask[]>([]);
  readonly loading = signal(false);
  readonly error = signal('');

  async buscar(filters: OperatorTaskFilters): Promise<PagedResult<OperatorTask>> {
    let params = new HttpParams()
      .set('page', filters.page)
      .set('pageSize', filters.pageSize)
      .set('sort', filters.sort);
    if (filters.sedeId) params = params.set('sedeId', filters.sedeId);
    if (filters.areaId) params = params.set('areaId', filters.areaId);
    if (filters.search.trim()) params = params.set('search', filters.search.trim());
    if (filters.type) params = params.set('type', filters.type);
    if (filters.operator.trim()) params = params.set('operator', filters.operator.trim());
    if (filters.from) params = params.set('from', filters.from);
    if (filters.to) params = params.set('to', filters.to);

    try {
      return await firstValueFrom(
        this.http.get<PagedResult<OperatorTask>>('/api/operator-tasks', { params }),
      );
    } catch (error: unknown) {
      const message = this.getErrorMessage(error, 'No se pudieron consultar las tareas.');
      this.error.set(message);
      throw new Error(message);
    }
  }

  async cargarOpciones(sedeId: string): Promise<OperatorTaskOptions> {
    try {
      return await firstValueFrom(
        this.http.get<OperatorTaskOptions>('/api/operator-tasks/options', {
          params: { sedeId },
        }),
      );
    } catch (error: unknown) {
      throw new Error(this.getErrorMessage(error, 'No se pudieron cargar las opciones de tareas.'));
    }
  }

  async cargar(): Promise<void> {
    this.loading.set(true);
    try {
      const tasks = await firstValueFrom(this.http.get<OperatorTask[]>('/api/operator-tasks'));
      this.tasks.set(tasks);
      this.error.set('');
    } catch (error: unknown) {
      const message = this.getErrorMessage(error, 'No se pudieron cargar las tareas.');
      this.error.set(message);
      throw new Error(message);
    } finally {
      this.loading.set(false);
    }
  }

  async crear(task: NewOperatorTask): Promise<OperatorTask> {
    try {
      const created = await firstValueFrom(
        this.http.post<OperatorTask>('/api/operator-tasks', task),
      );
      this.tasks.update((tasks) => [created, ...tasks]);
      this.error.set('');
      return created;
    } catch (error: unknown) {
      const message = this.getErrorMessage(error, 'No se pudo guardar la tarea.');
      this.error.set(message);
      throw new Error(message);
    }
  }

  async editar(id: string, task: NewOperatorTask): Promise<OperatorTask> {
    try {
      const updated = await firstValueFrom(
        this.http.put<OperatorTask>(`/api/operator-tasks/${encodeURIComponent(id)}`, task),
      );
      this.tasks.update((tasks) => tasks.map((item) => (item.id === id ? updated : item)));
      this.error.set('');
      return updated;
    } catch (error: unknown) {
      const message = this.getErrorMessage(error, 'No se pudo actualizar la tarea.');
      this.error.set(message);
      throw new Error(message);
    }
  }

  private getErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof HttpErrorResponse) {
      return typeof error.error?.error === 'string' ? error.error.error : fallback;
    }
    return error instanceof Error ? error.message : fallback;
  }
}

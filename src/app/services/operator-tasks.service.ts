import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

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
  createdAt: string;
}

export interface NewOperatorTask {
  sedeId: string;
  tipo: OperatorTaskType;
  titulo: string;
  descripcion: string;
  duracionMinutos: number | null;
}

@Injectable({ providedIn: 'root' })
export class OperatorTasksService {
  private readonly http = inject(HttpClient);
  readonly tasks = signal<OperatorTask[]>([]);
  readonly loading = signal(false);
  readonly error = signal('');

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

  private getErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof HttpErrorResponse) {
      return typeof error.error?.error === 'string' ? error.error.error : fallback;
    }
    return error instanceof Error ? error.message : fallback;
  }
}

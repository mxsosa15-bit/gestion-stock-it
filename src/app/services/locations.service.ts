import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { Sede } from '../models/inventory.model';

export interface NewLocation {
  nombre: string;
  departamento: string;
  localidad: string;
  direccion: string;
}

export type DashboardLocation = Pick<Sede, 'id' | 'nombre' | 'tipo'>;

@Injectable({ providedIn: 'root' })
export class LocationsService {
  private readonly http = inject(HttpClient);
  readonly sedes = signal<Sede[]>([]);
  readonly error = signal('');

  async listarParaDashboard(): Promise<DashboardLocation[]> {
    try {
      return await firstValueFrom(this.http.get<DashboardLocation[]>('/api/sedes/dashboard'));
    } catch (error: unknown) {
      throw new Error(this.getErrorMessage(error, 'No se pudieron cargar las sedes.'));
    }
  }

  async cargar(): Promise<void> {
    try {
      const sedes = await firstValueFrom(this.http.get<Sede[]>('/api/sedes'));
      this.sedes.set(sedes);
      this.error.set('');
    } catch (error: unknown) {
      const message = this.getErrorMessage(error, 'No se pudieron cargar las sedes.');
      this.error.set(message);
      throw new Error(message);
    }
  }

  async crear(location: NewLocation): Promise<Sede> {
    try {
      const sede = await firstValueFrom(this.http.post<Sede>('/api/sedes', location));
      this.sedes.update((sedes) =>
        [...sedes, sede].sort(
          (left, right) =>
            Number(right.tipo === 'CENTRAL') - Number(left.tipo === 'CENTRAL') ||
            left.nombre.localeCompare(right.nombre),
        ),
      );
      this.error.set('');
      return sede;
    } catch (error: unknown) {
      const message = this.getErrorMessage(error, 'No se pudo crear la sede.');
      this.error.set(message);
      throw new Error(message);
    }
  }

  async actualizar(id: string, location: NewLocation): Promise<Sede> {
    try {
      const sede = await firstValueFrom(
        this.http.patch<Sede>(`/api/sedes/${encodeURIComponent(id)}`, location),
      );
      this.sedes.update((sedes) =>
        sedes
          .map((item) => (item.id === id ? sede : item))
          .sort(
            (left, right) =>
              Number(right.tipo === 'CENTRAL') - Number(left.tipo === 'CENTRAL') ||
              left.nombre.localeCompare(right.nombre),
          ),
      );
      this.error.set('');
      return sede;
    } catch (error: unknown) {
      const message = this.getErrorMessage(error, 'No se pudo actualizar la sede.');
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

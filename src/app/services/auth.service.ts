import { isPlatformBrowser } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable, PLATFORM_ID, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface AuthenticatedUser {
  id: string;
  username: string;
  role: SystemRole;
  areaId: string | null;
  areaNombre: string | null;
}

export type SystemRole = 'admin' | 'operator' | 'solicitante' | 'dashboard';

export interface ManagedArea {
  id: string;
  nombre: string;
}

export interface ManagedUser {
  id: string;
  username: string;
  role: SystemRole;
  areaId: string | null;
  areaNombre: string | null;
  createdAt: string;
}

interface SessionResponse {
  authenticated: boolean;
  user: AuthenticatedUser | null;
  setupRequired: boolean;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly platformId = inject(PLATFORM_ID);

  readonly user = signal<AuthenticatedUser | null>(null);
  readonly initialized = signal(false);
  readonly setupRequired = signal(false);
  readonly error = signal('');
  readonly pending = signal(false);
  readonly usuarios = signal<ManagedUser[]>([]);
  readonly areas = signal<ManagedArea[]>([]);

  async initialize(): Promise<void> {
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }
    try {
      const response = await firstValueFrom(this.http.get<SessionResponse>('/api/auth/session'));
      this.user.set(response.user);
      this.setupRequired.set(response.setupRequired);
      this.error.set('');
    } catch (error: unknown) {
      this.error.set(this.getErrorMessage(error, 'No se pudo conectar con el servidor.'));
    } finally {
      this.initialized.set(true);
    }
  }

  async iniciarSesion(username: string, password: string): Promise<void> {
    this.pending.set(true);
    this.error.set('');
    try {
      const response = await firstValueFrom(
        this.http.post<{ user: AuthenticatedUser }>('/api/auth/login', { username, password }),
      );
      this.user.set(response.user);
    } catch (error: unknown) {
      this.error.set(this.getErrorMessage(error, 'No se pudo iniciar sesión.'));
      throw error;
    } finally {
      this.pending.set(false);
    }
  }

  async configurarAdministrador(username: string, password: string): Promise<void> {
    this.pending.set(true);
    this.error.set('');
    try {
      const response = await firstValueFrom(
        this.http.post<{ user: AuthenticatedUser }>('/api/auth/setup', { username, password }),
      );
      this.user.set(response.user);
      this.setupRequired.set(false);
    } catch (error: unknown) {
      this.error.set(this.getErrorMessage(error, 'No se pudo configurar la cuenta inicial.'));
      throw error;
    } finally {
      this.pending.set(false);
    }
  }

  async cerrarSesion(): Promise<void> {
    this.pending.set(true);
    this.error.set('');
    try {
      await firstValueFrom(this.http.post<void>('/api/auth/logout', {}));
      this.user.set(null);
    } catch (error: unknown) {
      this.error.set(this.getErrorMessage(error, 'No se pudo cerrar la sesión.'));
      throw error;
    } finally {
      this.pending.set(false);
    }
  }

  async cargarUsuarios(): Promise<void> {
    const users = await firstValueFrom(this.http.get<ManagedUser[]>('/api/admin/users'));
    this.usuarios.set(users);
  }

  async cargarAreas(): Promise<void> {
    const areas = await firstValueFrom(this.http.get<ManagedArea[]>('/api/admin/areas'));
    this.areas.set(areas);
  }

  async crearUsuario(
    username: string,
    password: string,
    role: SystemRole,
    areaId: string | null,
  ): Promise<void> {
    await firstValueFrom(
      this.http.post<ManagedUser>('/api/admin/users', { username, password, role, areaId }),
    );
    await this.cargarUsuarios();
  }

  async restablecerContrasena(userId: string, password: string): Promise<void> {
    try {
      await firstValueFrom(
        this.http.put<{ message: string }>(
          `/api/admin/users/${encodeURIComponent(userId)}/password`,
          {
            password,
          },
        ),
      );
    } catch (error: unknown) {
      throw new Error(
        this.getErrorMessage(error, 'No se pudo restablecer la contraseña del usuario.'),
      );
    }
  }

  private getErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof HttpErrorResponse) {
      const message = error.error?.error;
      return typeof message === 'string' ? message : fallback;
    }
    return error instanceof Error ? error.message : fallback;
  }
}

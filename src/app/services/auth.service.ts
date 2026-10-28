import { isPlatformBrowser } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable, PLATFORM_ID, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface AuthenticatedUser {
  id: string;
  username: string;
  role: 'admin' | 'operator';
}

export interface ManagedUser {
  id: string;
  username: string;
  role: 'admin' | 'operator';
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

  async initialize(): Promise<void> {
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }
    try {
      const response = await firstValueFrom(
        this.http.get<SessionResponse>('/api/auth/session'),
      );
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
    const users = await firstValueFrom(
      this.http.get<ManagedUser[]>('/api/admin/users'),
    );
    this.usuarios.set(users);
  }

  async crearUsuario(
    username: string,
    password: string,
    role: ManagedUser['role'],
  ): Promise<void> {
    await firstValueFrom(
      this.http.post<ManagedUser>('/api/admin/users', { username, password, role }),
    );
    await this.cargarUsuarios();
  }

  private getErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof HttpErrorResponse) {
      const message = error.error?.error;
      return typeof message === 'string' ? message : fallback;
    }
    return error instanceof Error ? error.message : fallback;
  }
}

import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { TicketCategory } from '../../shared/tickets';

export type TicketState = 'Abierto' | 'En proceso' | 'Terminado';

export interface WorkshopTransfer {
  id: string;
  equipo: string;
  identificacion: string;
  detalle: string;
  estado: 'Pendiente' | 'Aprobado' | 'Rechazado';
  solicitado_at: string;
  solicitado_por_nombre: string;
  aprobado_at: string | null;
  aprobado_por_nombre: string | null;
  motivo_rechazo: string | null;
}

export interface SupportTicket {
  id: string;
  titulo: string;
  descripcion: string;
  categoria: TicketCategory;
  estado: TicketState;
  solucion: string | null;
  fecha_creacion: string;
  fecha_resolucion: string | null;
  usuario_id: string;
  usuario_nombre: string;
  area_nombre: string | null;
  taller: WorkshopTransfer | null;
}

export interface WorkshopTransferInput {
  equipo: string;
  identificacion: string;
  detalle: string;
}

@Injectable({ providedIn: 'root' })
export class TicketsService {
  private readonly http = inject(HttpClient);

  async listar(): Promise<SupportTicket[]> {
    try {
      return await firstValueFrom(this.http.get<SupportTicket[]>('/api/tickets'));
    } catch (error: unknown) {
      throw new Error(this.obtenerMensaje(error, 'No se pudieron cargar los reclamos activos.'));
    }
  }

  async listarMios(): Promise<SupportTicket[]> {
    try {
      return await firstValueFrom(this.http.get<SupportTicket[]>('/api/tickets/mine'));
    } catch (error: unknown) {
      throw new Error(this.obtenerMensaje(error, 'No se pudieron cargar tus reclamos.'));
    }
  }

  async listarPorArea(areaId: string): Promise<SupportTicket[]> {
    try {
      return await firstValueFrom(
        this.http.get<SupportTicket[]>(`/api/tickets/areas/${encodeURIComponent(areaId)}`),
      );
    } catch (error: unknown) {
      throw new Error(
        this.obtenerMensaje(error, 'No se pudo cargar el historial de reclamos del área.'),
      );
    }
  }

  async crear(
    titulo: string,
    descripcion: string,
    categoria: TicketCategory,
  ): Promise<SupportTicket> {
    try {
      return await firstValueFrom(
        this.http.post<SupportTicket>('/api/tickets', { titulo, descripcion, categoria }),
      );
    } catch (error: unknown) {
      throw new Error(this.obtenerMensaje(error, 'No se pudo enviar el reclamo.'));
    }
  }

  async derivarATaller(id: string, transfer: WorkshopTransferInput): Promise<SupportTicket> {
    try {
      return await firstValueFrom(
        this.http.post<SupportTicket>(`/api/tickets/${encodeURIComponent(id)}/workshop`, transfer),
      );
    } catch (error: unknown) {
      throw new Error(
        this.obtenerMensaje(error, 'No se pudo enviar la solicitud de derivación al taller.'),
      );
    }
  }

  async resolverDerivacion(
    ticketId: string,
    transferId: string,
    aprobar: boolean,
    motivo?: string,
  ): Promise<SupportTicket> {
    try {
      return await firstValueFrom(
        this.http.patch<SupportTicket>(
          `/api/tickets/${encodeURIComponent(ticketId)}/workshop/${encodeURIComponent(transferId)}`,
          { aprobar, motivo },
        ),
      );
    } catch (error: unknown) {
      throw new Error(
        this.obtenerMensaje(error, 'No se pudo registrar la decisión sobre el equipo.'),
      );
    }
  }

  async actualizar(
    id: string,
    estado: Exclude<TicketState, 'Abierto'>,
    solucion?: string,
  ): Promise<SupportTicket> {
    try {
      return await firstValueFrom(
        this.http.patch<SupportTicket>(`/api/tickets/${encodeURIComponent(id)}`, {
          estado,
          solucion,
        }),
      );
    } catch (error: unknown) {
      throw new Error(this.obtenerMensaje(error, 'No se pudo actualizar el reclamo.'));
    }
  }

  private obtenerMensaje(error: unknown, fallback: string): string {
    if (error instanceof HttpErrorResponse) {
      const message = error.error?.error;
      return typeof message === 'string' ? message : fallback;
    }
    return error instanceof Error ? error.message : fallback;
  }
}

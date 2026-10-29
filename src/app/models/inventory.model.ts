export type TipoPeriferico =
  | 'PROCESADOR'
  | 'RAM'
  | 'DISCO_HDD'
  | 'DISCO_SSD'
  | 'ALMACENAMIENTO'
  | 'GABINETE'
  | 'MONITOR'
  | 'TECLADO'
  | 'MOUSE'
  | 'SCANNER'
  | 'IMPRESORA'
  | 'OTRO';

export type TipoEquipoRed = 'SWITCH' | 'ROUTER' | 'AP';

export type EstadoComponenteRetirado = 'REPARACION' | 'SCRAP';

export interface Piso {
  id: string;
  nombre: string;
  nivel: number;
}

export interface Area {
  id: string;
  pisoId: string;
  nombre: string;
}

export interface ComponentePuesto {
  id: string;
  tipo: TipoPeriferico;
  marca: string;
  modelo?: string;
  especificacion: string;
  numeroSerie?: string;
  codigoSeguimiento?: string;
}

export interface PuestoTrabajo {
  id: string;
  areaId: string;
  nombrePuesto: string;
  usuarioAsignado: string;
  componentes: ComponentePuesto[];
  codigoSeguimiento: string;
}

export interface PersonaInventario {
  id: string;
  nombre: string;
  areaId: string;
  puestoId: string | null;
}

export interface EquipoRed {
  id: string;
  tipo: TipoEquipoRed;
  marca: string;
  modelo: string;
  areaId: string;
  codigoSeguimiento: string;
}

export interface StockInsumo {
  id: string;
  tipo: TipoPeriferico;
  marca: string;
  especificacion: string;
  cantidadDisponible: number;
  stockMinimo: number;
  codigoSeguimiento?: string;
}

export interface ComponenteRetirado {
  id: string;
  componente: ComponentePuesto;
  puestoId: string;
  puestoNombre: string;
  estado: EstadoComponenteRetirado;
  fechaRetiro: Date;
}

export type TipoMovimiento =
  | 'INGRESO_STOCK'
  | 'REEMPLAZO_PUESTO'
  | 'ALTA_PUESTO'
  | 'ALTA_COMPONENTE'
  | 'BAJA_PUESTO'
  | 'ALTA_EQUIPO_RED'
  | 'BAJA_EQUIPO_RED'
  | 'RETIRO_COMPONENTE'
  | 'CAMBIO_ESTADO_COMPONENTE';

export interface HistorialMovimiento {
  id: string;
  fecha: Date;
  tipo: TipoMovimiento;
  insumoId?: string;
  puestoId?: string;
  equipoRedId?: string;
  componenteRetiradoId?: string;
  cantidad: number;
  detalle: string;
}

export interface TransferenciaInventario {
  id: string;
  descripcion: string;
  creadoAt: string;
  creadoPor: string;
  movimientos: TransferenciaMovimiento[];
}

export interface TransferenciaMovimiento {
  id: string;
  tipoEntidad: 'AREA' | 'PERSONA' | 'COMPONENTE' | 'EQUIPO_RED';
  entidadId: string;
  nombreEntidad: string;
  origen: Record<string, string | null>;
  destino: Record<string, string | null>;
}

export interface SolicitudTransferenciaInventario {
  origenAreaId: string;
  destinoAreaId: string | null;
  destinoPuestoId: string | null;
  nuevoPuesto: { nombrePuesto: string } | null;
  personaIds: string[];
  componentes: { puestoId: string; componenteId: string }[];
  equipoRedIds: string[];
  moverAreaCompleta: boolean;
  destinoPisoId: string | null;
  descripcion: string;
}

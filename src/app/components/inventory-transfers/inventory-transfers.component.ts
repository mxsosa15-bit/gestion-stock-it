import { CommonModule, DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  PersonaInventario,
  SolicitudTransferenciaInventario,
  TransferenciaInventario,
} from '../../models/inventory.model';
import { InventoryService } from '../../services/inventory.service';

const CREATE_WORKSTATION = '__crear_puesto__';

@Component({
  selector: 'app-inventory-transfers',
  imports: [CommonModule, DatePipe, FormsModule],
  templateUrl: './inventory-transfers.component.html',
  styleUrl: './inventory-transfers.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InventoryTransfersComponent implements OnInit {
  readonly inventory = inject(InventoryService);
  readonly origenAreaId = signal('');
  readonly destinoAreaId = signal('');
  readonly destinoPuestoId = signal('');
  readonly nuevoPuestoNombre = signal('');
  readonly personaSeleccionadaId = signal('');
  readonly componentesSeleccionados = signal<string[]>([]);
  readonly equiposRedSeleccionados = signal<string[]>([]);
  readonly mudanzaCompleta = signal(false);
  readonly destinoPisoId = signal('');
  readonly descripcion = signal('');
  readonly cargandoHistorial = signal(false);
  readonly guardando = signal(false);
  readonly error = signal('');
  readonly aviso = signal('');
  readonly historial = signal<TransferenciaInventario[]>([]);

  readonly areasOrigen = computed(() => this.inventory.areas());
  readonly areasDestino = computed(() =>
    this.inventory.areas().filter((area) => area.id !== this.origenAreaId()),
  );
  readonly areaOrigen = computed(
    () => this.inventory.areas().find((area) => area.id === this.origenAreaId()) ?? null,
  );
  readonly areaDestino = computed(
    () => this.inventory.areas().find((area) => area.id === this.destinoAreaId()) ?? null,
  );
  readonly puestosOrigen = computed(() =>
    this.inventory.puestos().filter((puesto) => puesto.areaId === this.origenAreaId()),
  );
  readonly personasOrigen = computed(() =>
    this.inventory
      .personas()
      .filter((persona) => persona.areaId === this.origenAreaId())
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')),
  );
  readonly redesOrigen = computed(() =>
    this.inventory.equiposRed().filter((equipo) => equipo.areaId === this.origenAreaId()),
  );
  readonly puestosDestino = computed(() =>
    this.inventory.puestos().filter((puesto) => puesto.areaId === this.destinoAreaId()),
  );
  readonly destinoPuestoEsNuevo = computed(
    () => this.destinoPuestoId() === CREATE_WORKSTATION,
  );
  readonly componentesDisponibles = computed(() =>
    this.puestosOrigen().flatMap((puesto) =>
      puesto.componentes.map((componente) => ({
        puestoId: puesto.id,
        puestoNombre: puesto.nombrePuesto,
        usuario: puesto.usuarioAsignado,
        componente,
        key: this.componenteKey(puesto.id, componente.id),
      })),
    ),
  );
  readonly seleccionadoHayActivos = computed(
    () =>
      !!this.personaSeleccionadaId() ||
      this.componentesSeleccionados().length > 0 ||
      this.equiposRedSeleccionados().length > 0,
  );
  readonly pisoDestino = computed(() =>
    this.inventory.pisos().find((piso) => piso.id === this.areaDestino()?.pisoId),
  );

  ngOnInit(): void {
    void this.cargarHistorial();
  }

  nombrePuesto(persona: PersonaInventario): string {
    if (!persona.puestoId) return 'Sin puesto asignado';
    return this.inventory.puestos().find((puesto) => puesto.id === persona.puestoId)?.nombrePuesto ??
      'Sin puesto asignado';
  }

  cambiarOrigen(areaId: string): void {
    this.origenAreaId.set(areaId);
    this.limpiarSeleccion();
    if (areaId === this.destinoAreaId()) this.destinoAreaId.set('');
  }

  cambiarDestino(areaId: string): void {
    this.destinoAreaId.set(areaId);
    this.destinoPuestoId.set('');
    this.nuevoPuestoNombre.set('');
  }

  cambiarDestinoPuesto(puestoId: string): void {
    this.destinoPuestoId.set(puestoId);
    if (puestoId !== CREATE_WORKSTATION) this.nuevoPuestoNombre.set('');
  }

  seleccionarPersona(persona: PersonaInventario, checked: boolean): void {
    this.personaSeleccionadaId.set(checked ? persona.id : '');
  }

  seleccionarPersonaDesdeEvento(persona: PersonaInventario, event: Event): void {
    const checkbox = event.target;
    if (checkbox instanceof HTMLInputElement) {
      this.seleccionarPersona(persona, checkbox.checked);
    }
  }

  seleccionarComponente(puestoId: string, componenteId: string, checked: boolean): void {
    const key = this.componenteKey(puestoId, componenteId);
    this.componentesSeleccionados.update((ids) =>
      checked ? (ids.includes(key) ? ids : [...ids, key]) : ids.filter((id) => id !== key),
    );
  }

  seleccionarEquipoRed(id: string, checked: boolean): void {
    this.equiposRedSeleccionados.update((ids) =>
      checked ? (ids.includes(id) ? ids : [...ids, id]) : ids.filter((item) => item !== id),
    );
  }

  cambiarMudanzaCompleta(enabled: boolean): void {
    this.mudanzaCompleta.set(enabled);
    this.limpiarSeleccion();
    this.destinoAreaId.set('');
    this.destinoPuestoId.set('');
    this.destinoPisoId.set('');
  }

  cambiarMudanzaCompletaDesdeEvento(event: Event): void {
    const checkbox = event.target;
    if (checkbox instanceof HTMLInputElement) {
      this.cambiarMudanzaCompleta(checkbox.checked);
    }
  }

  tieneComponenteSeleccionado(key: string): boolean {
    return this.componentesSeleccionados().includes(key);
  }

  tieneEquipoRedSeleccionado(id: string): boolean {
    return this.equiposRedSeleccionados().includes(id);
  }

  seleccionarComponenteDesdeEvento(
    puestoId: string,
    componenteId: string,
    event: Event,
  ): void {
    const checkbox = event.target;
    if (checkbox instanceof HTMLInputElement) {
      this.seleccionarComponente(puestoId, componenteId, checkbox.checked);
    }
  }

  seleccionarEquipoRedDesdeEvento(id: string, event: Event): void {
    const checkbox = event.target;
    if (checkbox instanceof HTMLInputElement) {
      this.seleccionarEquipoRed(id, checkbox.checked);
    }
  }

  async ejecutarTransferencia(): Promise<void> {
    this.error.set('');
    this.aviso.set('');
    const descripcion = this.descripcion().trim();
    if (!this.origenAreaId() || !descripcion) {
      this.error.set('Seleccioná el origen y describí el motivo de la transferencia.');
      return;
    }

    let request: SolicitudTransferenciaInventario;
    if (this.mudanzaCompleta()) {
      if (!this.destinoPisoId() || this.destinoPisoId() === this.areaOrigen()?.pisoId) {
        this.error.set('Seleccioná un piso de destino distinto del actual.');
        return;
      }
      request = {
        origenAreaId: this.origenAreaId(),
        destinoAreaId: this.origenAreaId(),
        destinoPuestoId: null,
        nuevoPuesto: null,
        personaIds: [],
        componentes: [],
        equipoRedIds: [],
        moverAreaCompleta: true,
        destinoPisoId: this.destinoPisoId(),
        descripcion,
      };
    } else {
      if (!this.destinoAreaId() || !this.seleccionadoHayActivos()) {
        this.error.set('Seleccioná el área de destino y al menos una persona o un activo.');
        return;
      }
      const needsWorkstation =
        !!this.personaSeleccionadaId() || this.componentesSeleccionados().length > 0;
      const createWorkstation = this.destinoPuestoEsNuevo();
      const workstationName = this.nuevoPuestoNombre().trim();
      if (
        needsWorkstation &&
        (!this.destinoPuestoId() ||
          (createWorkstation && (!workstationName || workstationName.length > 200)))
      ) {
        this.error.set(
          createWorkstation
            ? 'Ingresá el nombre del nuevo puesto de destino.'
            : 'Seleccioná o creá un puesto de destino para la persona o el equipo.',
        );
        return;
      }
      const selectedComponents = new Set(this.componentesSeleccionados());
      request = {
        origenAreaId: this.origenAreaId(),
        destinoAreaId: this.destinoAreaId(),
        destinoPuestoId:
          needsWorkstation && !createWorkstation ? this.destinoPuestoId() : null,
        nuevoPuesto: createWorkstation ? { nombrePuesto: workstationName } : null,
        personaIds: this.personaSeleccionadaId() ? [this.personaSeleccionadaId()] : [],
        componentes: this.componentesDisponibles()
          .filter((item) => selectedComponents.has(item.key))
          .map((item) => ({
            puestoId: item.puestoId,
            componenteId: item.componente.id,
          })),
        equipoRedIds: this.equiposRedSeleccionados(),
        moverAreaCompleta: false,
        destinoPisoId: null,
        descripcion,
      };
    }

    this.guardando.set(true);
    try {
      await this.inventory.ejecutarTransferencia(request);
      this.aviso.set('La transferencia se registró y el inventario quedó actualizado.');
      this.descripcion.set('');
      this.limpiarSeleccion();
      this.destinoPuestoId.set('');
      this.nuevoPuestoNombre.set('');
      this.destinoPisoId.set('');
      await this.cargarHistorial();
    } catch (error: unknown) {
      this.error.set(
        error instanceof Error ? error.message : 'No se pudo completar la transferencia.',
      );
    } finally {
      this.guardando.set(false);
    }
  }

  textoArea(areaId: string | null): string {
    if (!areaId) return 'Sin área';
    const area = this.inventory.areas().find((item) => item.id === areaId);
    return area?.nombre ?? areaId;
  }

  textoPiso(floorId: string | null): string {
    if (!floorId) return 'Sin piso';
    const floor = this.inventory.pisos().find((item) => item.id === floorId);
    return floor?.nombre ?? floorId;
  }

  textoUbicacion(value: Record<string, string | null>): string {
    const floor = this.textoPiso(value['floorId'] ?? null);
    const area = this.textoArea(value['areaId'] ?? null);
    const workstationId = value['workstationId'];
    const workstation = workstationId
      ? this.inventory.puestos().find((item) => item.id === workstationId)?.nombrePuesto ??
        workstationId
      : '';
    return [floor, area, workstation].filter(Boolean).join(' · ');
  }

  async recargarHistorial(): Promise<void> {
    await this.cargarHistorial();
  }

  private async cargarHistorial(): Promise<void> {
    this.cargandoHistorial.set(true);
    try {
      this.historial.set(await this.inventory.listarTransferencias());
    } catch (error: unknown) {
      this.error.set(
        error instanceof Error ? error.message : 'No se pudo cargar el historial de transferencias.',
      );
    } finally {
      this.cargandoHistorial.set(false);
    }
  }

  private limpiarSeleccion(): void {
    this.personaSeleccionadaId.set('');
    this.componentesSeleccionados.set([]);
    this.equiposRedSeleccionados.set([]);
  }

  private componenteKey(puestoId: string, componenteId: string): string {
    return JSON.stringify([puestoId, componenteId]);
  }
}

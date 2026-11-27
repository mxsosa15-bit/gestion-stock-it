import { CommonModule, DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  OnChanges,
  OnInit,
  signal,
  SimpleChanges,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../services/auth.service';
import {
  OperatorTaskOptions,
  OperatorTaskRelatedAssetType,
  OperatorTask,
  OperatorTaskFilters,
  OperatorTaskType,
  OperatorTasksService,
} from '../../services/operator-tasks.service';

@Component({
  selector: 'app-operator-tasks',
  imports: [CommonModule, FormsModule, DatePipe],
  templateUrl: './operator-tasks.component.html',
  styleUrl: './operator-tasks.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OperatorTasksComponent implements OnChanges, OnInit {
  private requestSequence = 0;
  private optionsSequence = 0;
  readonly tasksService = inject(OperatorTasksService);
  readonly authService = inject(AuthService);
  readonly sedeId = input.required<string>();
  readonly sedeNombre = input.required<string>();
  readonly titulo = signal('');
  readonly descripcion = signal('');
  readonly tipo = signal<OperatorTaskType>('Mantenimiento');
  readonly duracionMinutos = signal<number | null>(null);
  readonly areaId = signal('');
  readonly relatedAssetType = signal<OperatorTaskRelatedAssetType | null>(null);
  readonly relatedAssetId = signal('');
  readonly operatorId = signal('');
  readonly performedAt = signal(this.toDateTimeLocal(new Date().toISOString()));
  readonly observaciones = signal('');
  readonly tareaEnEdicion = signal<OperatorTask | null>(null);
  readonly opciones = signal<OperatorTaskOptions | null>(null);
  readonly loadingOptions = signal(false);
  readonly optionsError = signal('');
  readonly guardando = signal(false);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly filtroTexto = signal('');
  readonly filtroTipo = signal('');
  readonly filtroOperador = signal('');
  readonly filtroArea = signal('');
  readonly fechaDesde = signal('');
  readonly fechaHasta = signal('');
  readonly orden = signal<'newest' | 'oldest'>('newest');
  readonly pagina = signal(1);
  readonly paginaTamano = 25;
  readonly tareas = signal<OperatorTask[]>([]);
  readonly totalTareas = signal(0);
  readonly tipos: readonly OperatorTaskType[] = [
    'Mantenimiento',
    'Instalación',
    'Configuración',
    'Relevamiento',
    'Otro',
  ];
  readonly totalPaginas = computed(() =>
    Math.max(1, Math.ceil(this.totalTareas() / this.paginaTamano)),
  );
  readonly isAdmin = computed(() => this.authService.user()?.role === 'admin');
  readonly relatedAssetChoices = computed(() => {
    const choices = [...(this.opciones()?.relatedAssets ?? [])];
    const type = this.relatedAssetType();
    const id = this.relatedAssetId();
    if (
      type &&
      id &&
      !choices.some((asset) => asset.type === type && asset.id === id)
    ) {
      choices.push({
        type,
        id,
        areaId: this.areaId() || null,
        label: `Referencia histórica no disponible (${type}: ${id})`,
      });
    }
    return choices;
  });
  readonly selectedRelatedAssetKey = computed(() => {
    const type = this.relatedAssetType();
    const id = this.relatedAssetId();
    return type && id ? `${type}:${id}` : '';
  });

  ngOnInit(): void {
    void this.inicializar();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['sedeId'] && !changes['sedeId'].firstChange) {
      this.cancelarEdicion();
      void this.inicializar();
    }
  }

  async guardar(): Promise<void> {
    if (this.guardando()) return;
    const titulo = this.titulo().trim();
    const descripcion = this.descripcion().trim();
    const duracion = this.duracionMinutos();
    const realizationDate = new Date(this.performedAt());
    if (
      !titulo ||
      !descripcion ||
      !this.sedeId() ||
      !this.performedAt() ||
      Number.isNaN(realizationDate.getTime())
    ) {
      this.error.set('Completá un título, una descripción y una fecha de realización válidos.');
      return;
    }
    if (duracion !== null && (!Number.isInteger(duracion) || duracion < 0 || duracion > 1440)) {
      this.error.set('La duración debe ser un número entero entre 0 y 1440 minutos.');
      return;
    }

    this.error.set('');
    const taskData = {
      sedeId: this.sedeId(),
      areaId: this.areaId() || null,
      relatedAssetType: this.relatedAssetType(),
      relatedAssetId: this.relatedAssetId() || null,
      operatorId: this.operatorId() || null,
      performedAt: realizationDate.toISOString(),
      observaciones: this.observaciones().trim(),
      tipo: this.tipo(),
      titulo,
      descripcion,
      duracionMinutos: duracion,
    };
    const editing = this.tareaEnEdicion();
    const operator =
      this.opciones()?.operators.find((item) => item.id === taskData.operatorId)?.username ??
      this.authService.user()?.username ??
      'Operador no identificado';
    const area =
      this.opciones()?.areas.find((item) => item.id === taskData.areaId)?.nombre ??
      'Sin área asociada';
    const relatedAsset = this.relatedAssetChoices().find(
      (item) => item.type === taskData.relatedAssetType && item.id === taskData.relatedAssetId,
    )?.label;
    const resumen = [
      `Tarea: ${editing?.titulo ?? 'Nueva tarea'} → ${titulo}`,
      `Tipo: ${editing?.tipo ?? '—'} → ${taskData.tipo}`,
      `Operador: ${operator}`,
      `Fecha: ${realizationDate.toLocaleString('es-AR')}`,
      `Sede: ${this.sedeNombre()}`,
      `Área: ${area}`,
      ...(relatedAsset ? [`Equipo relacionado: ${relatedAsset}`] : []),
      ...(editing ? [`Descripción anterior: ${editing.descripcion}`] : []),
      `Descripción: ${descripcion}`,
    ].join('\n');
    if (
      !window.confirm(
        `¿Confirmás ${editing ? 'modificar' : 'registrar'} esta tarea${editing ? ` (${editing.titulo})` : ''}?\n\n${resumen}`,
      )
    ) return;
    this.guardando.set(true);
    try {
      if (editing) {
        await this.tasksService.editar(editing.id, taskData);
      } else {
        await this.tasksService.crear(taskData);
      }
      this.limpiarFormulario();
      await this.cargarPagina(1);
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'No se pudo guardar la tarea.');
    } finally {
      this.guardando.set(false);
    }
  }

  private async inicializar(): Promise<void> {
    const optionsSequence = ++this.optionsSequence;
    this.loadingOptions.set(true);
    this.optionsError.set('');
    try {
      const options = await this.tasksService.cargarOpciones(this.sedeId());
      if (optionsSequence !== this.optionsSequence) return;
      this.opciones.set(options);
      if (
        !this.operatorId() ||
        !options.operators.some((operator) => operator.id === this.operatorId())
      ) {
        this.operatorId.set(this.authService.user()?.id ?? '');
      }
    } catch (error: unknown) {
      if (optionsSequence === this.optionsSequence) {
        this.optionsError.set(
          error instanceof Error ? error.message : 'No se pudieron cargar las opciones de tareas.',
        );
      }
    } finally {
      if (optionsSequence === this.optionsSequence) this.loadingOptions.set(false);
    }
    await this.cargarPagina(1);
  }

  async cargarPagina(page = 1): Promise<void> {
    const requestSequence = ++this.requestSequence;
    this.pagina.set(page);
    this.error.set('');
    this.loading.set(true);
    try {
      const filters: OperatorTaskFilters = {
        sedeId: this.sedeId(),
        areaId: this.filtroArea(),
        search: this.filtroTexto(),
        type: this.filtroTipo(),
        operator: this.filtroOperador(),
        from: this.fechaDesde(),
        to: this.fechaHasta(),
        sort: this.orden(),
        page,
        pageSize: this.paginaTamano,
      };
      const result = await this.tasksService.buscar(filters);
      if (requestSequence === this.requestSequence) {
        this.tareas.set(result.items);
        this.totalTareas.set(result.total);
      }
    } catch (error: unknown) {
      if (requestSequence === this.requestSequence) {
        this.error.set(
          error instanceof Error ? error.message : 'No se pudieron cargar las tareas.',
        );
      }
    } finally {
      if (requestSequence === this.requestSequence) this.loading.set(false);
    }
  }

  aplicarFiltros(): void {
    void this.cargarPagina(1);
  }

  limpiarFiltros(): void {
    this.filtroTexto.set('');
    this.filtroTipo.set('');
    this.filtroOperador.set('');
    this.filtroArea.set('');
    this.fechaDesde.set('');
    this.fechaHasta.set('');
    this.orden.set('newest');
    this.aplicarFiltros();
  }

  paginaAnterior(): void {
    if (this.pagina() > 1) void this.cargarPagina(this.pagina() - 1);
  }

  paginaSiguiente(): void {
    if (this.pagina() < this.totalPaginas()) void this.cargarPagina(this.pagina() + 1);
  }

  iniciarEdicion(task: OperatorTask): void {
    this.tareaEnEdicion.set(task);
    this.titulo.set(task.titulo);
    this.descripcion.set(task.descripcion);
    this.tipo.set(task.tipo);
    this.duracionMinutos.set(task.duracionMinutos);
    this.areaId.set(task.areaId ?? '');
    this.relatedAssetType.set(task.relatedAssetType);
    this.relatedAssetId.set(task.relatedAssetId ?? '');
    this.operatorId.set(task.operadorId);
    this.performedAt.set(this.toDateTimeLocal(task.performedAt));
    this.observaciones.set(task.observaciones ?? '');
    this.error.set('');
  }

  cancelarEdicion(): void {
    this.limpiarFormulario();
  }

  cambiarArea(areaId: string): void {
    this.areaId.set(areaId);
    const selected = this.relatedAssetChoices().find(
      (asset) => asset.type === this.relatedAssetType() && asset.id === this.relatedAssetId(),
    );
    if (selected?.areaId && selected.areaId !== areaId) {
      this.relatedAssetType.set(null);
      this.relatedAssetId.set('');
    }
  }

  cambiarEquipoRelacionado(key: string): void {
    const selected = this.relatedAssetChoices().find((asset) => `${asset.type}:${asset.id}` === key);
    this.relatedAssetType.set(selected?.type ?? null);
    this.relatedAssetId.set(selected?.id ?? '');
    if (selected?.areaId) this.areaId.set(selected.areaId);
  }

  nombreEquipoRelacionado(task: OperatorTask): string {
    if (!task.relatedAssetType || !task.relatedAssetId) return '';
    return (
      this.opciones()?.relatedAssets.find(
        (asset) => asset.type === task.relatedAssetType && asset.id === task.relatedAssetId,
      )?.label ?? `${task.relatedAssetType} · ${task.relatedAssetId}`
    );
  }

  private limpiarFormulario(): void {
    this.tareaEnEdicion.set(null);
    this.titulo.set('');
    this.descripcion.set('');
    this.tipo.set('Mantenimiento');
    this.duracionMinutos.set(null);
    this.areaId.set('');
    this.relatedAssetType.set(null);
    this.relatedAssetId.set('');
    this.operatorId.set(this.authService.user()?.id ?? '');
    this.performedAt.set(this.toDateTimeLocal(new Date().toISOString()));
    this.observaciones.set('');
    this.error.set('');
  }

  private toDateTimeLocal(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  }
}

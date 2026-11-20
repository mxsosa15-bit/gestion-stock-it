import { CommonModule, DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  OnInit,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { OperatorTaskType, OperatorTasksService } from '../../services/operator-tasks.service';

@Component({
  selector: 'app-operator-tasks',
  imports: [CommonModule, FormsModule, DatePipe],
  templateUrl: './operator-tasks.component.html',
  styleUrl: './operator-tasks.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OperatorTasksComponent implements OnInit {
  readonly tasksService = inject(OperatorTasksService);
  readonly sedeId = input.required<string>();
  readonly sedeNombre = input.required<string>();
  readonly titulo = signal('');
  readonly descripcion = signal('');
  readonly tipo = signal<OperatorTaskType>('Mantenimiento');
  readonly duracionMinutos = signal<number | null>(null);
  readonly guardando = signal(false);
  readonly error = signal('');
  readonly tipos: readonly OperatorTaskType[] = [
    'Mantenimiento',
    'Instalación',
    'Configuración',
    'Relevamiento',
    'Otro',
  ];
  readonly tareas = computed(() =>
    this.tasksService
      .tasks()
      .filter((task) => task.sedeId === this.sedeId())
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
  );

  ngOnInit(): void {
    void this.cargar();
  }

  async guardar(): Promise<void> {
    const titulo = this.titulo().trim();
    const descripcion = this.descripcion().trim();
    const duracion = this.duracionMinutos();
    if (!titulo || !descripcion || !this.sedeId()) {
      this.error.set('Completá el título y la descripción de la tarea.');
      return;
    }
    if (duracion !== null && (!Number.isInteger(duracion) || duracion < 0 || duracion > 1440)) {
      this.error.set('La duración debe ser un número entero entre 0 y 1440 minutos.');
      return;
    }

    this.error.set('');
    this.guardando.set(true);
    try {
      await this.tasksService.crear({
        sedeId: this.sedeId(),
        tipo: this.tipo(),
        titulo,
        descripcion,
        duracionMinutos: duracion,
      });
      this.titulo.set('');
      this.descripcion.set('');
      this.duracionMinutos.set(null);
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'No se pudo guardar la tarea.');
    } finally {
      this.guardando.set(false);
    }
  }

  private async cargar(): Promise<void> {
    try {
      await this.tasksService.cargar();
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'No se pudieron cargar las tareas.');
    }
  }
}

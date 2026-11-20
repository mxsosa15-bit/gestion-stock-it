import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DEFAULT_SEDE_ID } from '../../../shared/locations';
import type { StockInsumo } from '../../models/inventory.model';
import { InventoryService } from '../../services/inventory.service';
import { LocationsService } from '../../services/locations.service';

@Component({
  selector: 'app-stock-dispatch',
  imports: [CommonModule, FormsModule],
  templateUrl: './stock-dispatch.component.html',
  styleUrl: './stock-dispatch.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StockDispatchComponent implements OnInit {
  readonly inventory = inject(InventoryService);
  readonly locations = inject(LocationsService);
  readonly insumoId = signal('');
  readonly destinoSedeId = signal('');
  readonly cantidad = signal(1);
  readonly motivo = signal('');
  readonly enviando = signal(false);
  readonly error = signal('');
  readonly aviso = signal('');

  readonly delegaciones = computed(() =>
    this.locations.sedes().filter((sede) => sede.tipo === 'DELEGACION' && sede.activa),
  );
  readonly stockCentral = computed(() =>
    this.inventory
      .stock()
      .filter(
        (insumo) =>
          (insumo.sedeId ?? DEFAULT_SEDE_ID) === DEFAULT_SEDE_ID && insumo.cantidadDisponible > 0,
      )
      .sort((left, right) =>
        `${left.tipo} ${left.marca} ${left.especificacion}`.localeCompare(
          `${right.tipo} ${right.marca} ${right.especificacion}`,
          'es',
        ),
      ),
  );
  readonly insumoSeleccionado = computed(
    () => this.stockCentral().find((insumo) => insumo.id === this.insumoId()) ?? null,
  );

  ngOnInit(): void {
    if (this.locations.sedes().length === 0) {
      void this.locations.cargar().catch((error: unknown) => {
        this.error.set(
          error instanceof Error ? error.message : 'No se pudieron cargar las delegaciones.',
        );
      });
    }
  }

  etiquetaInsumo(insumo: StockInsumo): string {
    return `${insumo.tipo} · ${insumo.marca} · ${insumo.especificacion} (${insumo.cantidadDisponible} disponibles)`;
  }

  async enviar(): Promise<void> {
    const insumo = this.insumoSeleccionado();
    const destino = this.destinoSedeId();
    const cantidad = this.cantidad();
    const motivo = this.motivo().trim();
    this.error.set('');
    this.aviso.set('');

    if (!insumo || !destino || !Number.isSafeInteger(cantidad) || cantidad <= 0) {
      this.error.set('Seleccioná un producto, una delegación y una cantidad válida.');
      return;
    }
    if (cantidad > insumo.cantidadDisponible) {
      this.error.set('La cantidad supera las existencias de Casa Central.');
      return;
    }
    if (!motivo || motivo.length > 500) {
      this.error.set('Indicá el motivo del envío (hasta 500 caracteres).');
      return;
    }

    this.enviando.set(true);
    try {
      await this.inventory.enviarStockADelegacion(insumo.id, destino, cantidad, motivo);
      this.aviso.set(
        `Se enviaron ${cantidad} unidades a ${this.delegaciones().find((sede) => sede.id === destino)?.nombre ?? 'la delegación'}.`,
      );
      this.insumoId.set('');
      this.cantidad.set(1);
      this.motivo.set('');
    } catch (error: unknown) {
      this.error.set(
        error instanceof Error ? error.message : 'No se pudo completar el envío de stock.',
      );
    } finally {
      this.enviando.set(false);
    }
  }
}

import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { AuthService } from '../../services/auth.service';
import { InventoryService } from '../../services/inventory.service';

@Component({
  selector: 'app-read-only-dashboard',
  imports: [CommonModule],
  templateUrl: './read-only-dashboard.component.html',
  styleUrl: './read-only-dashboard.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReadOnlyDashboardComponent {
  readonly authService = inject(AuthService);
  readonly inventory = inject(InventoryService);
  readonly totalUnits = computed(() =>
    this.inventory.stock().reduce((total, item) => total + item.cantidadDisponible, 0),
  );

  nombreArea(areaId: string): string {
    return this.inventory.areas().find((area) => area.id === areaId)?.nombre ?? 'Área no asignada';
  }

  async cerrarSesion(): Promise<void> {
    try {
      await this.authService.cerrarSesion();
    } catch {
      // The authentication service exposes the session error.
    }
  }
}

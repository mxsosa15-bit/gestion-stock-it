import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AuthService } from '../../services/auth.service';
import { OperationsDashboardComponent } from '../operations-dashboard/operations-dashboard.component';

@Component({
  selector: 'app-read-only-dashboard',
  imports: [OperationsDashboardComponent],
  templateUrl: './read-only-dashboard.component.html',
  styleUrl: './read-only-dashboard.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReadOnlyDashboardComponent {
  readonly authService = inject(AuthService);

  async cerrarSesion(): Promise<void> {
    try {
      await this.authService.cerrarSesion();
    } catch {
      // The authentication service exposes the session error.
    }
  }
}

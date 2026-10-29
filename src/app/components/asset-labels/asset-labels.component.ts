import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  inject,
  OnInit,
  QueryList,
  signal,
  ViewChildren,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  HardwareAsset,
  HardwareAssetInput,
  HardwareAssetsService,
  HardwareType,
  parseHardwareCsv,
} from '../../services/hardware-assets.service';

@Component({
  selector: 'app-asset-labels',
  imports: [CommonModule, FormsModule],
  templateUrl: './asset-labels.component.html',
  styleUrl: './asset-labels.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AssetLabelsComponent implements OnInit {
  private readonly hardwareService = inject(HardwareAssetsService);
  private readonly changeDetector = inject(ChangeDetectorRef);

  readonly types: HardwareType[] = ['MONITOR', 'IMPRESORA', 'SCANNER', 'TECLADO', 'MOUSE', 'OTRO'];
  readonly assets = signal<HardwareAsset[]>([]);
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly importing = signal(false);
  readonly printing = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  readonly filter = signal('');
  readonly selectedIds = signal<Set<string>>(new Set());
  readonly patrimonyDrafts = signal<Record<string, string>>({});
  readonly newAsset = signal({
    tipo: 'MONITOR' as HardwareType,
    marca: '',
    modelo: '',
    especificacion: '',
    numeroSerie: '',
    numeroPatrimonio: '',
  });
  readonly importDefaults = signal({
    tipo: 'MONITOR' as HardwareType,
    marca: '',
    modelo: '',
    especificacion: '',
  });

  @ViewChildren('patrimonyBarcode')
  private barcodeElements!: QueryList<ElementRef<SVGSVGElement>>;

  get filteredAssets(): HardwareAsset[] {
    const query = this.filter().trim().toLocaleLowerCase();
    if (!query) return this.assets();
    return this.assets().filter((asset) =>
      [asset.tipo, asset.marca, asset.modelo ?? '', asset.numeroSerie, asset.numeroPatrimonio ?? '']
        .join(' ')
        .toLocaleLowerCase()
        .includes(query),
    );
  }

  get printableAssets(): HardwareAsset[] {
    const selected = this.selectedIds();
    return this.assets().filter(
      (asset) => selected.has(asset.id) && Boolean(asset.numeroPatrimonio),
    );
  }

  ngOnInit(): void {
    void this.cargar();
  }

  actualizarNuevoAsset(campo: keyof ReturnType<typeof this.newAsset>, value: string): void {
    this.newAsset.update((asset) => ({ ...asset, [campo]: value }));
  }

  actualizarImportDefault(
    campo: keyof ReturnType<typeof this.importDefaults>,
    value: string,
  ): void {
    this.importDefaults.update((defaults) => ({ ...defaults, [campo]: value }));
  }

  actualizarFiltro(event: Event): void {
    const input = event.target;
    if (input instanceof HTMLInputElement) this.filter.set(input.value);
  }

  actualizarPatrimonio(asset: HardwareAsset, event: Event): void {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    this.patrimonyDrafts.update((drafts) => ({ ...drafts, [asset.id]: input.value }));
  }

  seleccionar(asset: HardwareAsset, event: Event): void {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    this.selectedIds.update((ids) => {
      const updated = new Set(ids);
      if (input.checked) updated.add(asset.id);
      else updated.delete(asset.id);
      return updated;
    });
  }

  async registrarEquipo(): Promise<void> {
    const form = this.newAsset();
    const numeroSerie = form.numeroSerie.trim();
    const marca = form.marca.trim();
    if (!numeroSerie || !marca) {
      this.error.set('Completá la marca y el número de serie del equipo.');
      return;
    }

    await this.withSaving(async () => {
      const created = await this.hardwareService.crear({
        tipo: form.tipo,
        marca,
        modelo: form.modelo.trim() || null,
        especificacion: form.especificacion.trim() || null,
        numeroSerie,
        numeroPatrimonio: form.numeroPatrimonio.trim() || null,
      });
      this.assets.update((assets) => [created, ...assets]);
      this.newAsset.update((asset) => ({
        ...asset,
        numeroSerie: '',
        numeroPatrimonio: '',
      }));
      this.notice.set('Se registró el equipo por su número de serie.');
    });
  }

  async importarCsv(event: Event): Promise<void> {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const file = input.files?.[0];
    if (!file) return;
    this.error.set('');
    this.notice.set('');
    this.importing.set(true);
    try {
      const parsed = parseHardwareCsv(await file.text(), this.importDefaults());
      if (parsed.errors.length) {
        this.error.set(parsed.errors.join(' '));
        return;
      }
      const imported = await this.hardwareService.importar(parsed.assets);
      this.assets.update((assets) => [...imported, ...assets]);
      this.notice.set(
        `Se importaron ${imported.length} equipos. Ya podés asociar las etiquetas recibidas.`,
      );
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'No se pudo importar el CSV.');
    } finally {
      this.importing.set(false);
      input.value = '';
    }
  }

  async guardarPatrimonio(asset: HardwareAsset): Promise<void> {
    const draft = this.patrimonyDrafts()[asset.id];
    if (draft === undefined) return;
    await this.withSaving(async () => {
      const updated = await this.hardwareService.guardarPatrimonio(asset.id, draft.trim() || null);
      this.assets.update((assets) => assets.map((item) => (item.id === asset.id ? updated : item)));
      this.patrimonyDrafts.update((drafts) => {
        const { [asset.id]: _savedDraft, ...remaining } = drafts;
        return remaining;
      });
      this.notice.set(
        updated.numeroPatrimonio
          ? `Se asoció la etiqueta ${updated.numeroPatrimonio} a la serie ${updated.numeroSerie}.`
          : `Se quitó la etiqueta de la serie ${updated.numeroSerie}.`,
      );
    });
  }

  async imprimirSeleccionadas(): Promise<void> {
    if (!this.printableAssets.length) {
      this.error.set('Seleccioná equipos que ya tengan número patrimonial asociado.');
      return;
    }
    this.error.set('');
    this.printing.set(true);
    try {
      const { default: JsBarcode } = await import('jsbarcode');
      this.changeDetector.detectChanges();
      this.barcodeElements.forEach(({ nativeElement }) => {
        const number = nativeElement.dataset['code'];
        if (number) {
          JsBarcode(nativeElement, number, {
            format: 'CODE128',
            lineColor: '#111827',
            width: 1.5,
            height: 38,
            displayValue: false,
            margin: 0,
          });
        }
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      window.print();
    } catch (error: unknown) {
      this.error.set(
        error instanceof Error ? error.message : 'No se pudieron preparar las etiquetas.',
      );
    } finally {
      this.printing.set(false);
    }
  }

  private async cargar(): Promise<void> {
    try {
      this.assets.set(await this.hardwareService.listar());
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'No se pudieron cargar los equipos.');
    } finally {
      this.loading.set(false);
    }
  }

  private async withSaving(operation: () => Promise<void>): Promise<void> {
    this.error.set('');
    this.notice.set('');
    this.saving.set(true);
    try {
      await operation();
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'No se pudo guardar el equipo.');
    } finally {
      this.saving.set(false);
    }
  }
}

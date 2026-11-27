import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  inject,
  input,
  OnInit,
  QueryList,
  signal,
  ViewChildren,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  HardwareAsset,
  HardwareAssetEdit,
  HardwareAssetInput,
  HardwareAssetsService,
  HardwareType,
  parseHardwareCsv,
} from '../../services/hardware-assets.service';
import { DEFAULT_SEDE_ID } from '../../../shared/locations';

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
  readonly sedeId = input(DEFAULT_SEDE_ID);
  readonly sedeNombre = input('Casa Central');

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
  readonly editingAssetId = signal<string | null>(null);
  readonly assetEditDraft = signal<HardwareAssetEdit | null>(null);
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
    return this.assets().filter(
      (asset) =>
        (asset.sedeId ?? DEFAULT_SEDE_ID) === this.sedeId() &&
        (!query ||
          [
            asset.tipo,
            asset.marca,
            asset.modelo ?? '',
            asset.numeroSerie,
            asset.numeroPatrimonio ?? '',
          ]
            .join(' ')
            .toLocaleLowerCase()
            .includes(query)),
    );
  }

  get printableAssets(): HardwareAsset[] {
    const selected = this.selectedIds();
    return this.filteredAssets.filter(
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

  iniciarEdicion(asset: HardwareAsset): void {
    this.editingAssetId.set(asset.id);
    this.assetEditDraft.set({
      tipo: asset.tipo,
      marca: asset.marca,
      modelo: asset.modelo,
      especificacion: asset.especificacion,
    });
    this.error.set('');
  }

  actualizarCampoEdicion(
    campo: keyof HardwareAssetEdit,
    value: HardwareAssetEdit[keyof HardwareAssetEdit],
  ): void {
    this.assetEditDraft.update((draft) => {
      if (!draft) return null;
      if (campo === 'tipo') {
        const tipo =
          typeof value === 'string' ? this.types.find((type) => type === value) : undefined;
        return tipo ? { ...draft, tipo } : draft;
      }
      if (campo === 'marca') {
        return typeof value === 'string' ? { ...draft, marca: value } : draft;
      }
      if (campo === 'modelo') {
        return typeof value === 'string' || value === null
          ? { ...draft, modelo: value }
          : draft;
      }
      return typeof value === 'string' || value === null
        ? { ...draft, especificacion: value }
        : draft;
    });
  }

  cancelarEdicion(): void {
    if (this.saving()) return;
    this.editingAssetId.set(null);
    this.assetEditDraft.set(null);
  }

  async guardarEdicion(asset: HardwareAsset): Promise<void> {
    if (this.saving() || this.importing()) return;
    const draft = this.assetEditDraft();
    if (!draft || this.editingAssetId() !== asset.id) return;
    const changes: HardwareAssetEdit = {
      tipo: draft.tipo,
      marca: draft.marca.trim(),
      modelo: draft.modelo?.trim() || null,
      especificacion: draft.especificacion?.trim() || null,
    };
    if (!changes.marca) {
      this.error.set('La marca es obligatoria.');
      return;
    }
    const resumen = [
      `Equipo: ${asset.tipo} · ${asset.marca} ${asset.modelo ?? ''} · serie ${asset.numeroSerie}`,
      `Tipo: ${asset.tipo} → ${changes.tipo}`,
      `Marca: ${asset.marca} → ${changes.marca}`,
      `Modelo: ${asset.modelo ?? 'Sin modelo'} → ${changes.modelo ?? 'Sin modelo'}`,
      `Especificación: ${asset.especificacion ?? 'Sin especificación'} → ${changes.especificacion ?? 'Sin especificación'}`,
    ].join('\n');
    if (!window.confirm(`¿Confirmás modificar los datos del equipo?\n\n${resumen}`)) return;
    await this.withSaving(async () => {
      const updated = await this.hardwareService.editar(asset.id, changes);
      this.assets.update((assets) => assets.map((item) => (item.id === asset.id ? updated : item)));
      this.editingAssetId.set(null);
      this.assetEditDraft.set(null);
      this.notice.set('Se actualizaron los datos del equipo y quedó registrada la auditoría.');
    });
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
    if (this.saving() || this.importing()) return;
    const form = this.newAsset();
    const numeroSerie = form.numeroSerie.trim();
    const marca = form.marca.trim();
    if (!numeroSerie || !marca) {
      this.error.set('Completá la marca y el número de serie del equipo.');
      return;
    }
    if (
      !window.confirm(
        `¿Confirmás registrar este equipo patrimonial?\n\nTipo: ${form.tipo}\nMarca: ${marca}\nModelo: ${form.modelo.trim() || 'Sin modelo'}\nNúmero de serie: ${numeroSerie}\nNúmero patrimonial: ${form.numeroPatrimonio.trim() || 'Pendiente'}\nSede: ${this.sedeNombre()}`,
      )
    ) return;

    await this.withSaving(async () => {
      const created = await this.hardwareService.crear({
        tipo: form.tipo,
        marca,
        modelo: form.modelo.trim() || null,
        especificacion: form.especificacion.trim() || null,
        numeroSerie,
        numeroPatrimonio: form.numeroPatrimonio.trim() || null,
        sedeId: this.sedeId(),
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
    if (!file || this.importing() || this.saving()) return;
    this.error.set('');
    this.notice.set('');
    this.importing.set(true);
    try {
      const parsed = parseHardwareCsv(await file.text(), this.importDefaults());
      if (parsed.errors.length) {
        this.error.set(parsed.errors.join(' '));
        return;
      }
      const preview = parsed.assets
        .slice(0, 5)
        .map((asset) => `${asset.tipo} · ${asset.marca} · serie ${asset.numeroSerie}`);
      if (parsed.assets.length > preview.length) {
        preview.push(`y ${parsed.assets.length - preview.length} equipos más`);
      }
      if (
        !window.confirm(
          `¿Confirmás importar equipos desde "${file.name}"?\n\nSede: ${this.sedeNombre()}\nRegistros válidos del archivo: ${parsed.assets.length}\n${preview.join('\n') || 'No se encontraron registros.'}`,
        )
      ) return;
      const imported = await this.hardwareService.importar(
        parsed.assets.map((asset) => ({ ...asset, sedeId: this.sedeId() })),
      );
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
    if (this.saving() || this.importing()) return;
    const draft = this.patrimonyDrafts()[asset.id];
    if (draft === undefined) return;
    const numeroPatrimonio = draft.trim() || null;
    if (
      !window.confirm(
        numeroPatrimonio
          ? `¿Confirmás modificar el número patrimonial del equipo?\n\nSerie: ${asset.numeroSerie}\nNúmero patrimonial: ${asset.numeroPatrimonio ?? 'Sin etiqueta'} → ${numeroPatrimonio}`
          : `¿Confirmás quitar el número patrimonial del equipo?\n\nSerie: ${asset.numeroSerie}\nNúmero patrimonial: ${asset.numeroPatrimonio ?? 'Sin etiqueta'} → Sin etiqueta`,
      )
    ) {
      return;
    }
    await this.withSaving(async () => {
      const updated = await this.hardwareService.guardarPatrimonio(asset.id, numeroPatrimonio);
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
    if (this.saving()) return;
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

import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export type HardwareType = 'MONITOR' | 'IMPRESORA' | 'SCANNER' | 'TECLADO' | 'MOUSE' | 'OTRO';

export interface HardwareAssetInput {
  tipo: HardwareType;
  marca: string;
  modelo: string | null;
  especificacion: string | null;
  numeroSerie: string;
  numeroPatrimonio: string | null;
}

export interface HardwareAsset extends HardwareAssetInput {
  id: string;
  fechaRegistro: string;
}

export interface HardwareCsvResult {
  assets: HardwareAssetInput[];
  errors: string[];
}

const hardwareTypes: readonly HardwareType[] = [
  'MONITOR',
  'IMPRESORA',
  'SCANNER',
  'TECLADO',
  'MOUSE',
  'OTRO',
];

function isHardwareType(value: string): value is HardwareType {
  return hardwareTypes.some((type) => type === value);
}

export function parseHardwareCsv(
  content: string,
  defaults: Pick<HardwareAssetInput, 'tipo' | 'marca' | 'modelo' | 'especificacion'>,
): HardwareCsvResult {
  const rows = parseCsvRows(content);
  if (rows.length === 0) return { assets: [], errors: ['El archivo CSV está vacío.'] };

  const headers = rows[0]!.map((cell) =>
    cell
      .replace(/^\uFEFF/, '')
      .trim()
      .toLocaleLowerCase()
      .replaceAll(' ', '_'),
  );
  const serialIndex = ['numero_serie', 'serie', 'serial', 'serial_number'].find((header) =>
    headers.includes(header),
  );
  if (!serialIndex) {
    return {
      assets: [],
      errors: ['El CSV debe tener una columna numero_serie (también se acepta serie o serial).'],
    };
  }
  const indexOf = (name: string): number => headers.indexOf(name);
  const serialColumn = headers.indexOf(serialIndex);
  const assets: HardwareAssetInput[] = [];
  const errors: string[] = [];

  rows.slice(1).forEach((row, rowOffset) => {
    const rowNumber = rowOffset + 2;
    if (row.every((cell) => !cell.trim())) return;
    const tipoText = row[indexOf('tipo')]?.trim().toUpperCase() ?? '';
    const tipo = tipoText ? (isHardwareType(tipoText) ? tipoText : null) : defaults.tipo;
    const numeroSerie = row[serialColumn]?.trim() ?? '';
    const marca = row[indexOf('marca')]?.trim() || defaults.marca.trim();
    if (!tipo || !numeroSerie || !marca) {
      errors.push(`Fila ${rowNumber}: indicá tipo, marca y número de serie válidos.`);
      return;
    }
    assets.push({
      tipo,
      marca,
      modelo: row[indexOf('modelo')]?.trim() || defaults.modelo?.trim() || null,
      especificacion:
        row[indexOf('especificacion')]?.trim() || defaults.especificacion?.trim() || null,
      numeroSerie,
      numeroPatrimonio: row[indexOf('numero_patrimonio')]?.trim() || null,
    });
  });

  if (assets.length === 0 && errors.length === 0) {
    errors.push('El CSV no contiene filas con números de serie.');
  }
  return { assets, errors };
}

function parseCsvRows(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]!;
    if (character === '"') {
      if (quoted && content[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      row.push(field);
      field = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && content[index + 1] === '\n') index += 1;
      row.push(field);
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }

  if (quoted) return [];
  row.push(field);
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}

@Injectable({ providedIn: 'root' })
export class HardwareAssetsService {
  private readonly http = inject(HttpClient);

  async listar(): Promise<HardwareAsset[]> {
    try {
      return await firstValueFrom(this.http.get<HardwareAsset[]>('/api/hardware-assets'));
    } catch (error: unknown) {
      throw new Error(this.obtenerMensaje(error, 'No se pudieron cargar los equipos.'));
    }
  }

  async crear(asset: HardwareAssetInput): Promise<HardwareAsset> {
    try {
      return await firstValueFrom(this.http.post<HardwareAsset>('/api/hardware-assets', asset));
    } catch (error: unknown) {
      throw new Error(this.obtenerMensaje(error, 'No se pudo registrar el equipo.'));
    }
  }

  async importar(assets: HardwareAssetInput[]): Promise<HardwareAsset[]> {
    try {
      return await firstValueFrom(
        this.http.post<HardwareAsset[]>('/api/hardware-assets/import', { assets }),
      );
    } catch (error: unknown) {
      throw new Error(this.obtenerMensaje(error, 'No se pudo importar el archivo.'));
    }
  }

  async guardarPatrimonio(id: string, numeroPatrimonio: string | null): Promise<HardwareAsset> {
    try {
      return await firstValueFrom(
        this.http.put<HardwareAsset>(`/api/hardware-assets/${encodeURIComponent(id)}/patrimony`, {
          numeroPatrimonio,
        }),
      );
    } catch (error: unknown) {
      throw new Error(this.obtenerMensaje(error, 'No se pudo asociar la etiqueta.'));
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

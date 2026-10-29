import { parseHardwareCsv } from './hardware-assets.service';

describe('parseHardwareCsv', () => {
  const defaults = {
    tipo: 'MONITOR' as const,
    marca: 'Dell',
    modelo: '',
    especificacion: '',
  };

  it('imports series and optional patrimony labels from quoted CSV values', () => {
    const result = parseHardwareCsv(
      'numero_serie,tipo,marca,modelo,numero_patrimonio\r\nSN-001,MONITOR,Dell,"P2422H, Rev A",PAT-001\r\nSN-002,,,,',
      defaults,
    );

    expect(result.errors).toEqual([]);
    expect(result.assets).toEqual([
      {
        tipo: 'MONITOR',
        marca: 'Dell',
        modelo: 'P2422H, Rev A',
        especificacion: null,
        numeroSerie: 'SN-001',
        numeroPatrimonio: 'PAT-001',
      },
      {
        tipo: 'MONITOR',
        marca: 'Dell',
        modelo: null,
        especificacion: null,
        numeroSerie: 'SN-002',
        numeroPatrimonio: null,
      },
    ]);
  });

  it('reports absent serial columns and invalid rows', () => {
    expect(parseHardwareCsv('marca,modelo\nDell,P2422', defaults).errors.length).toBeGreaterThan(0);
    expect(
      parseHardwareCsv('numero_serie,tipo,marca\nSN-1,DESCONOCIDO,Dell', defaults).errors,
    ).toContain('Fila 2: indicá tipo, marca y número de serie válidos.');
  });
});

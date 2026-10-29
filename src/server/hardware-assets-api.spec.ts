import { parseHardwareAsset } from './hardware-assets-api';

describe('parseHardwareAsset', () => {
  it('trims serial, label, and descriptive fields for one physical device', () => {
    expect(
      parseHardwareAsset({
        tipo: 'MONITOR',
        marca: ' Dell ',
        modelo: ' P2422H ',
        especificacion: ' 24 pulgadas ',
        numeroSerie: ' SN-001 ',
        numeroPatrimonio: ' PAT-001 ',
      }),
    ).toEqual({
      tipo: 'MONITOR',
      marca: 'Dell',
      modelo: 'P2422H',
      especificacion: '24 pulgadas',
      numeroSerie: 'SN-001',
      numeroPatrimonio: 'PAT-001',
    });
  });

  it('rejects invalid type, missing serial, and oversized label', () => {
    expect(parseHardwareAsset(null)).toBeNull();
    expect(
      parseHardwareAsset({
        tipo: 'UNKNOWN',
        marca: 'Dell',
        numeroSerie: 'SN-001',
      }),
    ).toBeNull();
    expect(
      parseHardwareAsset({
        tipo: 'SCANNER',
        marca: 'Canon',
        numeroSerie: ' ',
      }),
    ).toBeNull();
    expect(
      parseHardwareAsset({
        tipo: 'IMPRESORA',
        marca: 'HP',
        numeroSerie: 'SN-002',
        numeroPatrimonio: 'P'.repeat(101),
      }),
    ).toBeNull();
  });
});

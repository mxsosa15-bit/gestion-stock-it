import { parseHardwareAsset, parseHardwareAssetEdit } from './hardware-assets-api';

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
      sedeId: '00000000-0000-4000-8000-000000000001',
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

describe('parseHardwareAssetEdit', () => {
  it('accepts descriptive fields and prevents serial, site, and label changes', () => {
    expect(
      parseHardwareAssetEdit({
        tipo: 'MONITOR',
        marca: ' Dell ',
        modelo: ' P2422H ',
        especificacion: ' 24 pulgadas ',
      }),
    ).toEqual({
      tipo: 'MONITOR',
      marca: 'Dell',
      modelo: 'P2422H',
      especificacion: '24 pulgadas',
    });
    for (const protectedField of ['numeroSerie', 'sedeId', 'numeroPatrimonio']) {
      expect(
        parseHardwareAssetEdit({
          tipo: 'MONITOR',
          marca: 'Dell',
          modelo: 'P2422H',
          especificacion: '24 pulgadas',
          [protectedField]: 'no-permitido',
        }),
      ).toBeNull();
    }
  });
});

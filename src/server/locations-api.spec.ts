import { parseLocationInput } from './locations-api';

describe('parseLocationInput', () => {
  it('trims and accepts a delegation with optional address details', () => {
    expect(
      parseLocationInput({
        nombre: '  Delegación Norte  ',
        departamento: '  Capital ',
        localidad: 'Ciudad',
        direccion: '',
      }),
    ).toEqual({
      nombre: 'Delegación Norte',
      departamento: 'Capital',
      localidad: 'Ciudad',
      direccion: '',
    });
  });

  it('rejects empty or oversized location names', () => {
    expect(parseLocationInput({ nombre: '  ' })).toBeNull();
    expect(parseLocationInput({ nombre: 'x'.repeat(121) })).toBeNull();
  });
});

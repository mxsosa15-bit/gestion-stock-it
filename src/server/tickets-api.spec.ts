import {
  canRequesterSeeTicketInArea,
  parseTicketInput,
  parseTicketUpdate,
  parseWorkshopApprovalInput,
  parseWorkshopTransferInput,
} from './tickets-api';

describe('canRequesterSeeTicketInArea', () => {
  it('only exposes tickets that share the authenticated requesters area', () => {
    expect(canRequesterSeeTicketInArea('area-a', 'area-a')).toBe(true);
    expect(canRequesterSeeTicketInArea('area-a', 'area-b')).toBe(false);
    expect(canRequesterSeeTicketInArea(null, 'area-a')).toBe(false);
    expect(canRequesterSeeTicketInArea('area-a', null)).toBe(false);
  });
});

describe('parseTicketInput', () => {
  it('trims and accepts a valid ticket', () => {
    expect(
      parseTicketInput({
        titulo: '  No conecta  ',
        descripcion: '  Revisar equipo  ',
        categoria: 'Red',
      }),
    ).toEqual({
      titulo: 'No conecta',
      descripcion: 'Revisar equipo',
      categoria: 'Red',
    });
  });

  it('rejects missing, blank, oversized, or non-string fields', () => {
    expect(parseTicketInput(null)).toBeNull();
    expect(parseTicketInput({ titulo: ' ', descripcion: 'detalle', categoria: 'Red' })).toBeNull();
    expect(parseTicketInput({ titulo: 'ok', descripcion: ' ', categoria: 'Red' })).toBeNull();
    expect(
      parseTicketInput({ titulo: 'x'.repeat(201), descripcion: 'detalle', categoria: 'Red' }),
    ).toBeNull();
    expect(
      parseTicketInput({ titulo: 'ok', descripcion: 'x'.repeat(10_001), categoria: 'Red' }),
    ).toBeNull();
    expect(
      parseTicketInput({ titulo: 'ok', descripcion: 'detalle', categoria: 'categoria libre' }),
    ).toBeNull();
    expect(parseTicketInput({ titulo: 12, descripcion: 'detalle', categoria: 'Red' })).toBeNull();
  });
});

describe('parseTicketUpdate', () => {
  it('accepts in-progress and requires a resolution when terminating', () => {
    expect(parseTicketUpdate({ estado: 'En proceso' })).toEqual({
      estado: 'En proceso',
      solucion: null,
    });
    expect(parseTicketUpdate({ estado: 'Terminado', solucion: 'Se reemplazó el cable.' })).toEqual({
      estado: 'Terminado',
      solucion: 'Se reemplazó el cable.',
    });
    expect(parseTicketUpdate({ estado: 'Terminado', solucion: '  ' })).toBeNull();
    expect(parseTicketUpdate({ estado: 'Resuelto', solucion: 'Hecho' })).toBeNull();
  });
});

describe('parseWorkshopTransferInput', () => {
  it('requires an exact equipment identifier and a transfer reason', () => {
    expect(
      parseWorkshopTransferInput({
        equipo: ' Monitor Dell ',
        identificacion: ' SN-123 ',
        detalle: 'No enciende',
      }),
    ).toEqual({
      equipo: 'Monitor Dell',
      identificacion: 'SN-123',
      detalle: 'No enciende',
    });
    expect(
      parseWorkshopTransferInput({ equipo: 'Monitor', identificacion: '', detalle: 'Falla' }),
    ).toBeNull();
    expect(
      parseWorkshopTransferInput({
        equipo: 'Monitor',
        identificacion: 'SN-1',
        detalle: 'x'.repeat(2_001),
      }),
    ).toBeNull();
  });
});

describe('parseWorkshopApprovalInput', () => {
  it('requires a decision and a reason when rejecting a transfer', () => {
    expect(parseWorkshopApprovalInput({ aprobar: true })).toEqual({
      aprobar: true,
      motivo: null,
    });
    expect(parseWorkshopApprovalInput({ aprobar: false, motivo: 'No corresponde' })).toEqual({
      aprobar: false,
      motivo: 'No corresponde',
    });
    expect(parseWorkshopApprovalInput({ aprobar: false, motivo: ' ' })).toBeNull();
    expect(parseWorkshopApprovalInput({ aprobar: 'true' })).toBeNull();
  });
});

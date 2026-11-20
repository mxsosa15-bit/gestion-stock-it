import {
  canRequesterSeeTicketInArea,
  parseTicketInput,
  parseTicketUpdate,
  parseWorkshopApprovalInput,
  parseWorkshopReturnInput,
  parseWorkshopTransferInput,
  validateWorkshopReturnEquipment,
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
        puestoAfectadoId: 'puesto-1',
      }),
    ).toEqual({
      titulo: 'No conecta',
      descripcion: 'Revisar equipo',
      categoria: 'Red',
      puestoAfectadoId: 'puesto-1',
    });
  });

  it('rejects missing, blank, oversized, or non-string fields', () => {
    expect(parseTicketInput(null)).toBeNull();
    expect(
      parseTicketInput({
        titulo: ' ',
        descripcion: 'detalle',
        categoria: 'Red',
        puestoAfectadoId: 'puesto-1',
      }),
    ).toBeNull();
    expect(
      parseTicketInput({
        titulo: 'ok',
        descripcion: ' ',
        categoria: 'Red',
        puestoAfectadoId: 'puesto-1',
      }),
    ).toBeNull();
    expect(
      parseTicketInput({
        titulo: 'x'.repeat(201),
        descripcion: 'detalle',
        categoria: 'Red',
        puestoAfectadoId: 'puesto-1',
      }),
    ).toBeNull();
    expect(
      parseTicketInput({
        titulo: 'ok',
        descripcion: 'x'.repeat(10_001),
        categoria: 'Red',
        puestoAfectadoId: 'puesto-1',
      }),
    ).toBeNull();
    expect(
      parseTicketInput({
        titulo: 'ok',
        descripcion: 'detalle',
        categoria: 'categoria libre',
        puestoAfectadoId: 'puesto-1',
      }),
    ).toBeNull();
    expect(
      parseTicketInput({
        titulo: 12,
        descripcion: 'detalle',
        categoria: 'Red',
        puestoAfectadoId: 'puesto-1',
      }),
    ).toBeNull();
    expect(
      parseTicketInput({
        titulo: 'ok',
        descripcion: 'detalle',
        categoria: 'Red',
        puestoAfectadoId: ' ',
      }),
    ).toBeNull();
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

describe('parseWorkshopReturnInput', () => {
  it('records the same equipment returned with the repair resolution', () => {
    expect(
      parseWorkshopReturnInput({
        solucion: '  Se reparó la fuente  ',
        resultadoEquipo: 'MISMO',
        equipoDevuelto: ' PC ',
        identificacionDevuelta: ' SN-1 ',
      }),
    ).toEqual({
      solucion: 'Se reparó la fuente',
      resultadoEquipo: 'MISMO',
      equipoDevuelto: 'PC',
      identificacionDevuelta: 'SN-1',
      motivoReemplazo: null,
    });
  });

  it('requires replacement details and a reason when the workshop changes equipment', () => {
    expect(
      parseWorkshopReturnInput({
        solucion: 'Se reemplazó el equipo.',
        resultadoEquipo: 'REEMPLAZO',
        equipoDevuelto: 'PC Dell',
        identificacionDevuelta: 'SN-2',
        motivoReemplazo: 'La placa madre no tiene reparación.',
      }),
    ).toMatchObject({
      resultadoEquipo: 'REEMPLAZO',
      identificacionDevuelta: 'SN-2',
      motivoReemplazo: 'La placa madre no tiene reparación.',
    });
    expect(
      parseWorkshopReturnInput({
        solucion: 'Se reemplazó el equipo.',
        resultadoEquipo: 'REEMPLAZO',
        equipoDevuelto: 'PC Dell',
        identificacionDevuelta: 'SN-2',
      }),
    ).toBeNull();
    expect(
      parseWorkshopReturnInput({
        solucion: 'Se reparó.',
        resultadoEquipo: 'MISMO',
        equipoDevuelto: 'PC',
        identificacionDevuelta: 'SN-1',
        motivoReemplazo: 'No corresponde',
      }),
    ).toBeNull();
  });

  it('rejects missing return details and oversized resolution text', () => {
    expect(parseWorkshopReturnInput({ solucion: ' ' })).toBeNull();
    expect(
      parseWorkshopReturnInput({
        solucion: 'x'.repeat(10_001),
        resultadoEquipo: 'MISMO',
        equipoDevuelto: 'PC',
        identificacionDevuelta: 'SN-1',
      }),
    ).toBeNull();
    expect(parseWorkshopReturnInput(null)).toBeNull();
  });
});

describe('validateWorkshopReturnEquipment', () => {
  const sentEquipment = 'PC Dell Optiplex';
  const sentIdentifier = 'SN-ORIGINAL';

  it('requires the original identifier when returning the same equipment', () => {
    const sameEquipment = parseWorkshopReturnInput({
      solucion: 'Se reparó.',
      resultadoEquipo: 'MISMO',
      equipoDevuelto: sentEquipment,
      identificacionDevuelta: sentIdentifier,
    });
    const mismatchedEquipment = parseWorkshopReturnInput({
      solucion: 'Se reparó.',
      resultadoEquipo: 'MISMO',
      equipoDevuelto: sentEquipment,
      identificacionDevuelta: 'SN-DISTINTO',
    });

    if (!sameEquipment || !mismatchedEquipment) throw new Error('Datos de prueba inválidos.');
    expect(
      validateWorkshopReturnEquipment(sameEquipment, sentEquipment, sentIdentifier),
    ).toBeNull();
    expect(
      validateWorkshopReturnEquipment(mismatchedEquipment, sentEquipment, sentIdentifier),
    ).toContain('deben coincidir');
  });

  it('rejects a replacement reported with the original equipment identifier', () => {
    const replacement = parseWorkshopReturnInput({
      solucion: 'Se reemplazó el equipo.',
      resultadoEquipo: 'REEMPLAZO',
      equipoDevuelto: 'PC Lenovo',
      identificacionDevuelta: sentIdentifier,
      motivoReemplazo: 'Equipo original irreparable.',
    });

    if (!replacement) throw new Error('Datos de prueba inválidos.');
    expect(validateWorkshopReturnEquipment(replacement, sentEquipment, sentIdentifier)).toContain(
      'distinta',
    );
  });
});

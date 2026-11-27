import { parseOperatorTaskInput } from './operator-tasks-api';

describe('parseOperatorTaskInput', () => {
  const validTask = {
    sedeId: '00000000-0000-4000-8000-000000000001',
    areaId: null,
    relatedAssetType: null,
    relatedAssetId: null,
    operatorId: null,
    performedAt: null,
    observations: '',
    tipo: 'Mantenimiento',
    titulo: 'Revisión de equipo',
    descripcion: 'Se limpió y verificó el equipo.',
    duracionMinutos: null,
  };

  it('accepts a standalone operator task without a support ticket reference', () => {
    expect(parseOperatorTaskInput(validTask)).toEqual(validTask);
  });

  it('allows an omitted duration and rejects invalid durations or location IDs', () => {
    const { duracionMinutos: _duration, ...withoutDuration } = validTask;
    expect(parseOperatorTaskInput(withoutDuration)?.duracionMinutos).toBeNull();
    expect(parseOperatorTaskInput({ ...validTask, duracionMinutos: -1 })).toBeNull();
    expect(parseOperatorTaskInput({ ...validTask, sedeId: 'not-a-uuid' })).toBeNull();
  });

  it('accepts a related workstation and realization timestamp', () => {
    const task = {
      ...validTask,
      relatedAssetType: 'PUESTO',
      relatedAssetId: 'puesto-123',
      areaId: 'area-456',
      performedAt: '2026-11-26T18:00:00.000Z',
      observaciones: 'Se verificó el equipo.',
    };
    expect(parseOperatorTaskInput(task)).toMatchObject({
      relatedAssetType: 'PUESTO',
      relatedAssetId: 'puesto-123',
      areaId: 'area-456',
      performedAt: '2026-11-26T18:00:00.000Z',
      observations: 'Se verificó el equipo.',
    });
  });

  it('rejects incomplete asset references and invalid realization timestamps', () => {
    expect(
      parseOperatorTaskInput({
        ...validTask,
        relatedAssetType: 'PUESTO',
      }),
    ).toBeNull();
    expect(parseOperatorTaskInput({ ...validTask, performedAt: 'invalid' })).toBeNull();
  });
});

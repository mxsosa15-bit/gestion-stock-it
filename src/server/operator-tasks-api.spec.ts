import { parseOperatorTaskInput } from './operator-tasks-api';

describe('parseOperatorTaskInput', () => {
  const validTask = {
    sedeId: '00000000-0000-4000-8000-000000000001',
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
});

import { parseOptionalDate, parseOptionalText, parsePageOptions } from './list-query';

describe('list query parsers', () => {
  it('applies bounded pagination defaults and rejects invalid values', () => {
    expect(parsePageOptions(undefined, undefined)).toEqual({
      page: 1,
      pageSize: 25,
      offset: 0,
    });
    expect(parsePageOptions('3', '20')).toEqual({ page: 3, pageSize: 20, offset: 40 });
    expect(parsePageOptions('0', '20')).toBeNull();
    expect(parsePageOptions('1', '101')).toBeNull();
  });

  it('accepts only bounded query text and real ISO dates', () => {
    expect(parseOptionalText('  switch  ')).toBe('switch');
    expect(parseOptionalText('x'.repeat(201))).toBeUndefined();
    expect(parseOptionalDate('2026-02-28')).toBe('2026-02-28');
    expect(parseOptionalDate('2026-02-30')).toBeUndefined();
  });
});

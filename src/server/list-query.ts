export interface PageOptions {
  page: number;
  pageSize: number;
  offset: number;
}

export function parsePageOptions(
  rawPage: unknown,
  rawPageSize: unknown,
  defaultPageSize = 25,
  maxPageSize = 100,
): PageOptions | null {
  const parsePositiveInteger = (value: unknown, fallback: number): number | null => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  };

  const page = parsePositiveInteger(rawPage, 1);
  const pageSize = parsePositiveInteger(rawPageSize, defaultPageSize);
  if (page === null || pageSize === null || pageSize > maxPageSize) return null;
  const offset = (page - 1) * pageSize;
  return Number.isSafeInteger(offset) ? { page, pageSize, offset } : null;
}

export function parseOptionalText(value: unknown, maxLength = 200): string | null | undefined {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > maxLength) return undefined;
  return value.trim() || null;
}

export function parseOptionalDate(value: unknown): string | null | undefined {
  if (value === undefined) return null;
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) ||
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value
  ) {
    return undefined;
  }
  return value;
}

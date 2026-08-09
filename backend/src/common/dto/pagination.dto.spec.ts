import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  PaginationQueryDto,
  pageRange,
  paginated,
} from './pagination.dto';

/** Mirrors the global ValidationPipe options set in main.ts. */
const parse = (query: Record<string, unknown>) => {
  const dto = plainToInstance(PaginationQueryDto, query, {
    enableImplicitConversion: true,
  });
  return { dto, errors: validateSync(dto, { whitelist: true }) };
};

describe('PaginationQueryDto', () => {
  it('defaults to the first page at the default size', () => {
    const { dto, errors } = parse({});
    expect(errors).toHaveLength(0);
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(DEFAULT_PAGE_SIZE);
  });

  it('coerces numeric strings from the query string', () => {
    const { dto, errors } = parse({ page: '3', limit: '50' });
    expect(errors).toHaveLength(0);
    expect(dto.page).toBe(3);
    expect(dto.limit).toBe(50);
  });

  it.each([
    ['a zero page', { page: 0 }],
    ['a negative page', { page: -1 }],
    ['a zero limit', { limit: 0 }],
    ['a limit above the cap', { limit: MAX_PAGE_SIZE + 1 }],
    ['a fractional page', { page: 1.5 }],
    ['a non-numeric page', { page: 'first' }],
  ])('rejects %s', (_label, query) => {
    expect(parse(query).errors.length).toBeGreaterThan(0);
  });

  it('accepts the exact boundary values', () => {
    expect(parse({ page: 1, limit: 1 }).errors).toHaveLength(0);
    expect(parse({ limit: MAX_PAGE_SIZE }).errors).toHaveLength(0);
  });
});

describe('pageRange', () => {
  it.each([
    [1, 25, [0, 24]],
    [2, 25, [25, 49]],
    [4, 10, [30, 39]],
    [1, 1, [0, 0]],
  ])('page %i of %i maps to %j', (page, limit, expected) => {
    expect(pageRange(page, limit)).toEqual(expected);
  });
});

describe('paginated', () => {
  it('reports more pages when the total exceeds the window', () => {
    expect(paginated([1, 2], 10, 1, 2)).toEqual({
      items: [1, 2],
      total: 10,
      page: 1,
      limit: 2,
      hasMore: true,
    });
  });

  it('reports no more pages on the exact last page', () => {
    expect(paginated([9, 10], 10, 5, 2).hasMore).toBe(false);
  });

  it('reports no more pages past the end', () => {
    expect(paginated([], 10, 99, 25).hasMore).toBe(false);
  });

  it('handles an empty result set', () => {
    expect(paginated([], 0, 1, 25)).toMatchObject({ total: 0, hasMore: false });
  });
});

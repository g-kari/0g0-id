import { describe, it, expect } from 'vitest';
import { parseDays, parsePagination } from './pagination';

describe('parsePagination', () => {
  it('デフォルト値を返す', () => {
    expect(parsePagination({})).toEqual({ limit: 20, offset: 0 });
  });

  it('カスタムデフォルト値を返す', () => {
    expect(parsePagination({}, { defaultLimit: 50, maxLimit: 100 })).toEqual({ limit: 50, offset: 0 });
  });

  it('limit と offset をパースする', () => {
    expect(parsePagination({ limit: '10', offset: '5' })).toEqual({ limit: 10, offset: 5 });
  });

  it('limit を maxLimit でキャップする', () => {
    expect(parsePagination({ limit: '200' }, { defaultLimit: 20, maxLimit: 100 })).toEqual({
      limit: 100,
      offset: 0,
    });
  });

  it('無効な limit でエラーを返す', () => {
    const result = parsePagination({ limit: 'abc' });
    expect('error' in result).toBe(true);
  });

  it('limit=0 でエラーを返す', () => {
    const result = parsePagination({ limit: '0' });
    expect('error' in result).toBe(true);
  });

  it('負の offset でエラーを返す', () => {
    const result = parsePagination({ offset: '-1' });
    expect('error' in result).toBe(true);
  });
});

describe('parseDays', () => {
  it('daysParam が undefined のとき undefined を返す', () => {
    expect(parseDays(undefined)).toBeUndefined();
  });

  it('"30" を { days: 30 } としてパースする', () => {
    expect(parseDays('30')).toEqual({ days: 30 });
  });

  it('"1" は最小値として有効', () => {
    expect(parseDays('1')).toEqual({ days: 1 });
  });

  it('"90" は最大値として有効', () => {
    expect(parseDays('90')).toEqual({ days: 90 });
  });

  it('"0" は範囲外としてエラーを返す', () => {
    const result = parseDays('0');
    expect(result).toBeDefined();
    expect('error' in result!).toBe(true);
  });

  it('"91" は範囲外としてエラーを返す', () => {
    const result = parseDays('91');
    expect(result).toBeDefined();
    expect('error' in result!).toBe(true);
  });

  it('"abc" は非整数としてエラーを返す', () => {
    const result = parseDays('abc');
    expect(result).toBeDefined();
    expect('error' in result!).toBe(true);
  });

  it('"1.5" のようなfloat文字列は拒否される', () => {
    const result = parseDays('1.5');
    expect(result).toBeDefined();
    expect('error' in result!).toBe(true);
  });

  it('カスタム minDays / maxDays を尊重する', () => {
    expect(parseDays('7', { minDays: 7, maxDays: 30 })).toEqual({ days: 7 });
    const result = parseDays('6', { minDays: 7, maxDays: 30 });
    expect(result).toBeDefined();
    expect('error' in result!).toBe(true);
  });
});

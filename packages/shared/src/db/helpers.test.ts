import { describe, it, expect } from 'vitest';
import { daysAgoIso } from './helpers';

describe('daysAgoIso', () => {
  it('基準時刻から指定日数前のISO文字列を返す', () => {
    const now = new Date('2026-04-10T12:00:00.000Z').getTime();
    const result = daysAgoIso(7, now);
    expect(result).toBe('2026-04-03T12:00:00.000Z');
  });

  it('1日前のISO文字列を返す', () => {
    const now = new Date('2026-04-10T00:00:00.000Z').getTime();
    const result = daysAgoIso(1, now);
    expect(result).toBe('2026-04-09T00:00:00.000Z');
  });

  it('0日前は基準時刻と同じ', () => {
    const now = new Date('2026-04-10T06:30:00.000Z').getTime();
    const result = daysAgoIso(0, now);
    expect(result).toBe('2026-04-10T06:30:00.000Z');
  });

  it('30日前のISO文字列を返す', () => {
    const now = new Date('2026-04-10T00:00:00.000Z').getTime();
    const result = daysAgoIso(30, now);
    expect(result).toBe('2026-03-11T00:00:00.000Z');
  });

  it('365日前のISO文字列を返す', () => {
    const now = new Date('2026-04-10T00:00:00.000Z').getTime();
    const result = daysAgoIso(365, now);
    expect(result).toBe('2025-04-10T00:00:00.000Z');
  });

  it('月をまたぐ計算が正しい', () => {
    const now = new Date('2026-03-01T00:00:00.000Z').getTime();
    const result = daysAgoIso(5, now);
    expect(result).toBe('2026-02-24T00:00:00.000Z');
  });

  it('ISO 8601形式の文字列を返す', () => {
    const now = Date.now();
    const result = daysAgoIso(10, now);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('nowを省略すると現在時刻基準で計算する', () => {
    const before = Date.now();
    const result = daysAgoIso(0);
    const after = Date.now();
    const resultMs = new Date(result).getTime();
    expect(resultMs).toBeGreaterThanOrEqual(before);
    expect(resultMs).toBeLessThanOrEqual(after);
  });
});

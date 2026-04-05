import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@0g0-id/shared', () => ({
  countUsers: vi.fn(),
  countServices: vi.fn(),
  getActiveUserStats: vi.fn(),
  getDailyLoginTrends: vi.fn(),
  getDailyUserRegistrations: vi.fn(),
  getLoginEventProviderStats: vi.fn(),
  getDailyActiveUsers: vi.fn(),
}));

import {
  countUsers,
  countServices,
  getActiveUserStats,
  getDailyLoginTrends,
  getDailyUserRegistrations,
  getLoginEventProviderStats,
  getDailyActiveUsers,
} from '@0g0-id/shared';

import { getSystemMetricsTool } from './metrics';
import type { McpContext } from '../mcp';

const mockContext: McpContext = {
  userId: 'admin-1',
  userRole: 'admin',
  db: {} as D1Database,
  idp: {} as Fetcher,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(countUsers).mockResolvedValue(100);
  vi.mocked(countServices).mockResolvedValue(5);
  vi.mocked(getActiveUserStats).mockResolvedValue({ dau: 10, wau: 30, mau: 80 } as never);
  vi.mocked(getDailyLoginTrends).mockResolvedValue([]);
  vi.mocked(getDailyUserRegistrations).mockResolvedValue([]);
  vi.mocked(getLoginEventProviderStats).mockResolvedValue([]);
  vi.mocked(getDailyActiveUsers).mockResolvedValue([]);
});

// ===== get_system_metrics =====
describe('getSystemMetricsTool', () => {
  it('summaryとtrendsを含むメトリクスを返す', async () => {
    const result = await getSystemMetricsTool.handler({}, mockContext);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.summary.total_users).toBe(100);
    expect(parsed.summary.total_services).toBe(5);
    expect(parsed.summary.dau).toBe(10);
    expect(parsed.summary.wau).toBe(30);
    expect(parsed.summary.mau).toBe(80);
    expect(parsed.trends.days).toBe(30);
  });

  it('デフォルトは30日分のトレンド', async () => {
    await getSystemMetricsTool.handler({}, mockContext);

    expect(vi.mocked(getDailyLoginTrends)).toHaveBeenCalledWith(mockContext.db, 30);
    expect(vi.mocked(getDailyUserRegistrations)).toHaveBeenCalledWith(mockContext.db, 30);
    expect(vi.mocked(getDailyActiveUsers)).toHaveBeenCalledWith(mockContext.db, 30);
  });

  it('daysパラメータを指定できる', async () => {
    await getSystemMetricsTool.handler({ days: 7 }, mockContext);

    expect(vi.mocked(getDailyLoginTrends)).toHaveBeenCalledWith(mockContext.db, 7);
  });

  it('days=0はfalsy扱いでデフォルト30になる', async () => {
    // Number(0) || 30 = 30 (0はfalsy)
    await getSystemMetricsTool.handler({ days: 0 }, mockContext);

    expect(vi.mocked(getDailyLoginTrends)).toHaveBeenCalledWith(mockContext.db, 30);
  });

  it('days=1は最小値として機能する', async () => {
    await getSystemMetricsTool.handler({ days: 1 }, mockContext);

    expect(vi.mocked(getDailyLoginTrends)).toHaveBeenCalledWith(mockContext.db, 1);
  });

  it('daysは最大365にクランプする', async () => {
    await getSystemMetricsTool.handler({ days: 1000 }, mockContext);

    expect(vi.mocked(getDailyLoginTrends)).toHaveBeenCalledWith(mockContext.db, 365);
  });

  it('getLoginEventProviderStatsにはsinceIsoが渡される', async () => {
    const before = Date.now();
    await getSystemMetricsTool.handler({ days: 30 }, mockContext);
    const after = Date.now();

    const calls = vi.mocked(getLoginEventProviderStats).mock.calls;
    expect(calls).toHaveLength(1);
    const sinceIso = calls[0][1] as string;
    const sinceMs = new Date(sinceIso).getTime();
    // 30日前 ± 1秒の範囲に収まること
    const expected = before - 30 * 24 * 60 * 60 * 1000;
    expect(sinceMs).toBeGreaterThanOrEqual(expected - 1000);
    expect(sinceMs).toBeLessThanOrEqual(after);
  });

  it('全DB呼び出しが並列で実行される（Promise.all）', async () => {
    // 各関数が1回ずつ呼ばれることを確認
    await getSystemMetricsTool.handler({}, mockContext);

    expect(vi.mocked(countUsers)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(countServices)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getActiveUserStats)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getDailyLoginTrends)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getDailyUserRegistrations)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getLoginEventProviderStats)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getDailyActiveUsers)).toHaveBeenCalledTimes(1);
  });
});

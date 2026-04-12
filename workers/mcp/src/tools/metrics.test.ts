import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

vi.mock("@0g0-id/shared", () => ({
  countUsers: vi.fn(),
  countServices: vi.fn(),
  getActiveUserStats: vi.fn(),
  getDailyLoginTrends: vi.fn(),
  getDailyUserRegistrations: vi.fn(),
  getLoginEventProviderStats: vi.fn(),
  getDailyActiveUsers: vi.fn(),
  getSuspiciousMultiCountryLogins: vi.fn(),
  getServiceTokenStats: vi.fn(),
}));

import {
  countUsers,
  countServices,
  getActiveUserStats,
  getDailyLoginTrends,
  getDailyUserRegistrations,
  getLoginEventProviderStats,
  getDailyActiveUsers,
  getSuspiciousMultiCountryLogins,
  getServiceTokenStats,
} from "@0g0-id/shared";

import {
  getSystemMetricsTool,
  getSuspiciousLoginsTool,
  getServiceTokenStatsTool,
  getActiveUserStatsTool,
  getDailyActiveUsersTool,
} from "./metrics";
import type { McpContext } from "../mcp";

const mockContext: McpContext = {
  userId: "admin-1",
  userRole: "admin",
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
  vi.mocked(getSuspiciousMultiCountryLogins).mockResolvedValue([]);
  vi.mocked(getServiceTokenStats).mockResolvedValue([]);
});

// ===== get_system_metrics =====
describe("getSystemMetricsTool", () => {
  it("summaryとtrendsを含むメトリクスを返す", async () => {
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

  it("デフォルトは30日分のトレンド", async () => {
    await getSystemMetricsTool.handler({}, mockContext);

    expect(vi.mocked(getDailyLoginTrends)).toHaveBeenCalledWith(mockContext.db, 30);
    expect(vi.mocked(getDailyUserRegistrations)).toHaveBeenCalledWith(mockContext.db, 30);
    expect(vi.mocked(getDailyActiveUsers)).toHaveBeenCalledWith(mockContext.db, 30);
  });

  it("daysパラメータを指定できる", async () => {
    await getSystemMetricsTool.handler({ days: 7 }, mockContext);

    expect(vi.mocked(getDailyLoginTrends)).toHaveBeenCalledWith(mockContext.db, 7);
  });

  it("days=0はfalsy扱いでデフォルト30になる", async () => {
    // Number(0) || 30 = 30 (0はfalsy)
    await getSystemMetricsTool.handler({ days: 0 }, mockContext);

    expect(vi.mocked(getDailyLoginTrends)).toHaveBeenCalledWith(mockContext.db, 30);
  });

  it("days=1は最小値として機能する", async () => {
    await getSystemMetricsTool.handler({ days: 1 }, mockContext);

    expect(vi.mocked(getDailyLoginTrends)).toHaveBeenCalledWith(mockContext.db, 1);
  });

  it("daysは最大365にクランプする", async () => {
    await getSystemMetricsTool.handler({ days: 1000 }, mockContext);

    expect(vi.mocked(getDailyLoginTrends)).toHaveBeenCalledWith(mockContext.db, 365);
  });

  it("getLoginEventProviderStatsにはsinceIsoが渡される", async () => {
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

  it("全DB呼び出しが並列で実行される（Promise.all）", async () => {
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

// ===== get_suspicious_logins =====
describe("getSuspiciousLoginsTool", () => {
  it("dataとmetaを含むレスポンスを返す", async () => {
    const mockLogins = [{ user_id: "u1", country_count: 3, countries: "JP,US,DE" }];
    vi.mocked(getSuspiciousMultiCountryLogins).mockResolvedValue(mockLogins as never);

    const result = await getSuspiciousLoginsTool.handler({}, mockContext);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data).toHaveLength(1);
    expect(parsed.data[0].user_id).toBe("u1");
    expect(parsed.meta.hours).toBe(24);
    expect(parsed.meta.min_countries).toBe(2);
  });

  it("デフォルトは24時間・2か国", async () => {
    await getSuspiciousLoginsTool.handler({}, mockContext);

    const calls = vi.mocked(getSuspiciousMultiCountryLogins).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][2]).toBe(2); // minCountries
  });

  it("hoursとmin_countriesを指定できる", async () => {
    await getSuspiciousLoginsTool.handler({ hours: 48, min_countries: 3 }, mockContext);

    const calls = vi.mocked(getSuspiciousMultiCountryLogins).mock.calls;
    expect(calls[0][2]).toBe(3);
    const parsed = JSON.parse(
      (await getSuspiciousLoginsTool.handler({ hours: 48 }, mockContext)).content[0].text,
    );
    expect(parsed.meta.hours).toBe(48);
  });

  it("hoursは最大168にクランプする", async () => {
    const result = await getSuspiciousLoginsTool.handler({ hours: 1000 }, mockContext);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.meta.hours).toBe(168);
  });

  it("hoursは最小1にクランプする", async () => {
    const result = await getSuspiciousLoginsTool.handler({ hours: 0 }, mockContext);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.meta.hours).toBe(24); // 0はfalsyなのでデフォルト24
  });

  it("sinceIsoが正しい時間範囲で渡される", async () => {
    const before = Date.now();
    await getSuspiciousLoginsTool.handler({ hours: 1 }, mockContext);
    const after = Date.now();

    const calls = vi.mocked(getSuspiciousMultiCountryLogins).mock.calls;
    const sinceMs = new Date(calls[0][1] as string).getTime();
    const expected = before - 1 * 60 * 60 * 1000;
    expect(sinceMs).toBeGreaterThanOrEqual(expected - 1000);
    expect(sinceMs).toBeLessThanOrEqual(after);
  });
});

// ===== get_service_token_stats =====
describe("getServiceTokenStatsTool", () => {
  it("dataを含むレスポンスを返す", async () => {
    const mockStats = [
      {
        service_id: "s1",
        service_name: "App A",
        authorized_user_count: 10,
        active_token_count: 15,
      },
    ];
    vi.mocked(getServiceTokenStats).mockResolvedValue(mockStats as never);

    const result = await getServiceTokenStatsTool.handler({}, mockContext);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data).toHaveLength(1);
    expect(parsed.data[0].service_id).toBe("s1");
    expect(parsed.data[0].authorized_user_count).toBe(10);
  });

  it("サービスが0件の場合は空配列を返す", async () => {
    vi.mocked(getServiceTokenStats).mockResolvedValue([]);

    const result = await getServiceTokenStatsTool.handler({}, mockContext);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data).toEqual([]);
  });

  it("getServiceTokenStatsにDBが渡される", async () => {
    await getServiceTokenStatsTool.handler({}, mockContext);

    expect(vi.mocked(getServiceTokenStats)).toHaveBeenCalledWith(mockContext.db);
    expect(vi.mocked(getServiceTokenStats)).toHaveBeenCalledTimes(1);
  });
});

// ===== get_active_user_stats =====
describe("getActiveUserStatsTool", () => {
  it("DAU/WAU/MAUをdataに含むレスポンスを返す", async () => {
    const result = await getActiveUserStatsTool.handler({}, mockContext);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data.dau).toBe(10);
    expect(parsed.data.wau).toBe(30);
    expect(parsed.data.mau).toBe(80);
  });

  it("getActiveUserStatsにDBが渡される", async () => {
    await getActiveUserStatsTool.handler({}, mockContext);

    expect(vi.mocked(getActiveUserStats)).toHaveBeenCalledWith(mockContext.db);
    expect(vi.mocked(getActiveUserStats)).toHaveBeenCalledTimes(1);
  });

  it("dau/wau/mauが0のときも正常に返す", async () => {
    vi.mocked(getActiveUserStats).mockResolvedValue({ dau: 0, wau: 0, mau: 0 } as never);

    const result = await getActiveUserStatsTool.handler({}, mockContext);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data.dau).toBe(0);
    expect(parsed.data.wau).toBe(0);
    expect(parsed.data.mau).toBe(0);
  });
});

// ===== get_daily_active_users =====
describe("getDailyActiveUsersTool", () => {
  it("dataとdaysを含むレスポンスを返す", async () => {
    const mockData = [
      { date: "2026-04-11", count: 5 },
      { date: "2026-04-12", count: 8 },
    ];
    vi.mocked(getDailyActiveUsers).mockResolvedValue(mockData as never);

    const result = await getDailyActiveUsersTool.handler({}, mockContext);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data).toHaveLength(2);
    expect(parsed.data[0].date).toBe("2026-04-11");
    expect(parsed.days).toBe(30);
  });

  it("デフォルトは30日", async () => {
    await getDailyActiveUsersTool.handler({}, mockContext);

    expect(vi.mocked(getDailyActiveUsers)).toHaveBeenCalledWith(mockContext.db, 30);
  });

  it("daysパラメータを指定できる", async () => {
    await getDailyActiveUsersTool.handler({ days: 7 }, mockContext);

    expect(vi.mocked(getDailyActiveUsers)).toHaveBeenCalledWith(mockContext.db, 7);
    const result = await getDailyActiveUsersTool.handler({ days: 7 }, mockContext);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.days).toBe(7);
  });

  it("daysは最大90にクランプする", async () => {
    const result = await getDailyActiveUsersTool.handler({ days: 365 }, mockContext);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.days).toBe(90);
  });

  it("days=0はfalsyなのでデフォルト30になる", async () => {
    const result = await getDailyActiveUsersTool.handler({ days: 0 }, mockContext);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.days).toBe(30);
  });

  it("空配列のときもdataは[]を返す", async () => {
    vi.mocked(getDailyActiveUsers).mockResolvedValue([]);

    const result = await getDailyActiveUsersTool.handler({}, mockContext);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data).toEqual([]);
  });
});

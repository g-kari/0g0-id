import type { McpTool } from "../mcp";
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

/** 指定した日数前の日時を ISO 8601 文字列で返す */
function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export const getSystemMetricsTool: McpTool = {
  definition: {
    name: "get_system_metrics",
    description:
      "システムメトリクス（ユーザー数、サービス数、ログイン統計、アクティブユーザー統計等）を取得する",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "トレンド統計の対象日数（デフォルト: 30）" },
      },
    },
  },
  handler: async (params, context) => {
    const days = Math.max(1, Math.min(365, Number(params.days) || 30));
    const sinceIso = daysAgoIso(days);

    const [
      totalUsers,
      totalServices,
      activeUserStats,
      dailyLoginTrends,
      dailyUserRegistrations,
      loginProviderStats,
      dailyActiveUsers,
    ] = await Promise.all([
      countUsers(context.db),
      countServices(context.db),
      getActiveUserStats(context.db),
      getDailyLoginTrends(context.db, days),
      getDailyUserRegistrations(context.db, days),
      getLoginEventProviderStats(context.db, sinceIso),
      getDailyActiveUsers(context.db, days),
    ]);

    const result = {
      summary: {
        total_users: totalUsers,
        total_services: totalServices,
        dau: activeUserStats.dau,
        wau: activeUserStats.wau,
        mau: activeUserStats.mau,
      },
      trends: {
        days,
        daily_logins: dailyLoginTrends,
        daily_registrations: dailyUserRegistrations,
        daily_active_users: dailyActiveUsers,
        login_by_provider: loginProviderStats,
      },
    };

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
};

export const getSuspiciousLoginsTool: McpTool = {
  definition: {
    name: "get_suspicious_logins",
    description: "短時間に複数の国からログインした疑わしいアカウントを検出する",
    inputSchema: {
      type: "object",
      properties: {
        hours: { type: "number", description: "遡る時間数（1〜168、デフォルト: 24）" },
        min_countries: {
          type: "number",
          description: "疑わしいとみなす最低国数（2〜10、デフォルト: 2）",
        },
      },
    },
  },
  handler: async (params, context) => {
    const hours = Math.min(Math.max(Number(params.hours) || 24, 1), 168);
    const minCountries = Math.min(Math.max(Number(params.min_countries) || 2, 2), 10);
    const sinceIso = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

    const logins = await getSuspiciousMultiCountryLogins(context.db, sinceIso, minCountries);

    const result = {
      data: logins,
      meta: { hours, min_countries: minCountries },
    };

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
};

export const getServiceTokenStatsTool: McpTool = {
  definition: {
    name: "get_service_token_stats",
    description: "全サービスのアクティブトークン統計（認可ユーザー数・トークン数）を取得する",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  handler: async (_params, context) => {
    const stats = await getServiceTokenStats(context.db);

    const result = { data: stats };

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
};

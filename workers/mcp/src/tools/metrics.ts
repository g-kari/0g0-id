import type { McpTool } from '../mcp';
import {
  countUsers,
  countServices,
  getActiveUserStats,
  getDailyLoginTrends,
  getDailyUserRegistrations,
  getLoginEventProviderStats,
  getDailyActiveUsers,
} from '@0g0-id/shared';

/** 指定した日数前の日時を ISO 8601 文字列で返す */
function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export const getSystemMetricsTool: McpTool = {
  definition: {
    name: 'get_system_metrics',
    description: 'システムメトリクス（ユーザー数、サービス数、ログイン統計、アクティブユーザー統計等）を取得する',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'トレンド統計の対象日数（デフォルト: 30）' },
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

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
};

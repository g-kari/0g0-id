export type PaginationResult = { limit: number; offset: number } | { error: string };

/**
 * クエリパラメータから limit / offset をパースし、バリデーションする。
 * 不正値の場合は error プロパティを持つオブジェクトを返す。
 */
export function parsePagination(
  query: { limit?: string; offset?: string },
  options: { defaultLimit: number; maxLimit: number } = { defaultLimit: 20, maxLimit: 100 }
): PaginationResult {
  const limitRaw = query.limit !== undefined ? parseInt(query.limit, 10) : options.defaultLimit;
  const offsetRaw = query.offset !== undefined ? parseInt(query.offset, 10) : 0;

  if (query.limit !== undefined && (isNaN(limitRaw) || limitRaw < 1)) {
    return { error: 'limit は1以上の整数で指定してください' };
  }
  if (query.offset !== undefined && (isNaN(offsetRaw) || offsetRaw < 0)) {
    return { error: 'offset は0以上の整数で指定してください' };
  }

  return {
    limit: Math.min(limitRaw, options.maxLimit),
    offset: offsetRaw,
  };
}

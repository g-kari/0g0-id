import type { Context, MiddlewareHandler } from "hono";

export type PaginationResult =
  | { limit: number; offset: number }
  | { error: { code: string; message: string } };

/**
 * クエリパラメータから limit / offset をパースし、バリデーションする。
 * 不正値の場合は error プロパティを持つオブジェクトを返す。
 */
export function parsePagination(
  query: { limit?: string; offset?: string },
  options: { defaultLimit: number; maxLimit: number } = { defaultLimit: 20, maxLimit: 100 },
): PaginationResult {
  if (query.limit !== undefined && !/^\d+$/.test(query.limit)) {
    return { error: { code: "BAD_REQUEST", message: "limit は1以上の整数で指定してください" } };
  }
  if (query.offset !== undefined && !/^\d+$/.test(query.offset)) {
    return { error: { code: "BAD_REQUEST", message: "offset は0以上の整数で指定してください" } };
  }

  const limitRaw = query.limit !== undefined ? parseInt(query.limit, 10) : options.defaultLimit;
  const offsetRaw = query.offset !== undefined ? parseInt(query.offset, 10) : 0;

  if (query.limit !== undefined && limitRaw < 1) {
    return { error: { code: "BAD_REQUEST", message: "limit は1以上の整数で指定してください" } };
  }

  return {
    limit: Math.min(limitRaw, options.maxLimit),
    offset: offsetRaw,
  };
}

export function requirePagination(
  c: Context,
  options: { defaultLimit: number; maxLimit: number } = { defaultLimit: 20, maxLimit: 100 },
): { limit: number; offset: number } | Response {
  const result = parsePagination(
    { limit: c.req.query("limit"), offset: c.req.query("offset") },
    options,
  );
  if ("error" in result) {
    return c.json({ error: result.error }, 400);
  }
  return result;
}

/**
 * Hono ミドルウェア版の pagination バリデーション。
 * c.get("pagination") で { limit, offset } を取得できる。
 *
 * @example
 * app.get("/", paginationMiddleware({ defaultLimit: 50, maxLimit: 100 }), async (c) => {
 *   const { limit, offset } = c.get("pagination");
 * });
 */
export function paginationMiddleware(
  options: { defaultLimit: number; maxLimit: number } = { defaultLimit: 20, maxLimit: 100 },
): MiddlewareHandler<{ Variables: { pagination: { limit: number; offset: number } } }> {
  return async (c, next) => {
    const result = parsePagination(
      { limit: c.req.query("limit"), offset: c.req.query("offset") },
      options,
    );
    if ("error" in result) {
      return c.json({ error: result.error }, 400);
    }
    c.set("pagination", result);
    await next();
  };
}

export type DaysResult = { days: number } | { error: { code: string; message: string } };

/**
 * クエリパラメータから days をパースし、バリデーションする。
 * daysParam が undefined の場合は undefined を返す（未指定）。
 * 不正値の場合は error プロパティを持つオブジェクトを返す。
 */
export function parseDays(
  daysParam: string | undefined,
  options: { minDays?: number; maxDays?: number } = {},
): DaysResult | undefined {
  if (daysParam === undefined) return undefined;
  const { minDays = 1, maxDays = 90 } = options;
  if (!/^\d+$/.test(daysParam)) {
    return {
      error: {
        code: "INVALID_REQUEST",
        message: `days must be an integer between ${minDays} and ${maxDays}`,
      },
    };
  }
  const days = parseInt(daysParam, 10);
  if (days < minDays || days > maxDays) {
    return {
      error: {
        code: "INVALID_REQUEST",
        message: `days must be an integer between ${minDays} and ${maxDays}`,
      },
    };
  }
  return { days };
}

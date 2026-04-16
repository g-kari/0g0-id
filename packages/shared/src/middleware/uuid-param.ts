import type { MiddlewareHandler } from "hono";
import { UUID_RE } from "../lib/validation";

/**
 * UUID パラメータバリデーションミドルウェアを生成するファクトリ関数。
 * 指定パラメータが UUID 形式でなければ 400 を返す。
 *
 * @param paramName - 検証対象のパスパラメータ名（デフォルト: "id"）
 * @param options.allowValues - UUID 以外に許可する値（例: ["me"]）
 * @param options.label - エラーメッセージに使うラベル（例: "user ID"）
 */
export function uuidParamMiddleware(
  paramName = "id",
  options: { allowValues?: readonly string[]; label?: string } = {},
): MiddlewareHandler {
  const { allowValues = [], label = `${paramName} ID` } = options;
  return async (c, next) => {
    const value = c.req.param(paramName) ?? "";
    if (allowValues.includes(value)) return next();
    if (!UUID_RE.test(value)) {
      return c.json({ error: { code: "BAD_REQUEST", message: `Invalid ${label} format` } }, 400);
    }
    await next();
  };
}

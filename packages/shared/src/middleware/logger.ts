import type { Context, MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import { createLogger, httpRequestMetadata } from "../lib/logger";

const HTTP_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "CONNECT",
  "TRACE",
]);

function requestLogPath(c: Context): string {
  // HTTPログのpathは登録patternのみ。query・param実値・未知pathを記録しない。
  // route登録値はコード定義のみを前提とし、request由来の値を登録しない。
  // catchall/404/例外は固定分類し、metadata欠落時にも生URLへfallbackしない。
  if (c.res.status >= 500) return "[error]";
  if (c.res.status === 404) return "[unmatched]";
  try {
    const pattern = routePath(c);
    if (
      typeof pattern !== "string" ||
      !pattern.startsWith("/") ||
      pattern === "/*" ||
      pattern.length > 256 ||
      /[\s@%?#]/.test(pattern)
    ) {
      return "[unmatched]";
    }
    return pattern;
  } catch {
    // ログ用metadataの取得失敗で本来のresponseや例外を上書きしない。
    return "[unmatched]";
  }
}

const httpLogger = createLogger("http");

export const logger = (): MiddlewareHandler => {
  return async (c, next) => {
    const start = Date.now();
    const { method } = c.req.raw;
    await next();
    const elapsed = Date.now() - start;
    httpLogger.info(
      "request",
      httpRequestMetadata(
        // 独自method文字列もrequest由来なので、標準method以外は固定分類する。
        HTTP_METHODS.has(method) ? method : "[other]",
        requestLogPath(c),
        c.res.status,
        elapsed,
      ),
    );
  };
};

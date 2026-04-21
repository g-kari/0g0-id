/**
 * id worker が RFC 9745 `Deprecation` / `Link; rel="deprecation"` ヘッダで
 * 返してくる非推奨通知を BFF 側でも観測するための汎用ユーティリティ（issue #156）。
 *
 * Response に `Deprecation` ヘッダが含まれていれば warn ログを出力する。
 * ヘッダがなければ即座に return する（no-op）。
 */
import { createLogger, type Logger } from "./logger";

/** 本ヘルパが出力する warn ログの msg。テストで固定アサーションするため export する。 */
export const UPSTREAM_DEPRECATION_LOG_MSG = "upstream deprecation notice from id worker";

export interface UpstreamDeprecationContext {
  /** 呼び出した HTTP メソッド（トレース用）。 */
  method: string;
  /** 呼び出した URL パス（トレース用。クエリは含めない想定）。 */
  path: string;
}

const defaultLogger = createLogger("bff-upstream-deprecation");

/**
 * id worker からの Response に `Deprecation` ヘッダが付与されていれば warn ログを出す。
 *
 * - ヘッダが無ければ no-op（検知対象外）
 * - ヘッダ値と Link ヘッダ値はそのまま構造化ログに載せる
 * - レスポンスボディには一切触れない（ストリーム消費を避ける）
 *
 * @param res id worker からの Response
 * @param context 呼び出し元情報（method / path）
 * @param logger テスト時に差し替え可能。未指定なら `bff-upstream-deprecation` コンテキストの既定ロガー。
 */
export function logUpstreamDeprecation(
  res: Response,
  context: UpstreamDeprecationContext,
  logger: Logger = defaultLogger,
): void {
  const deprecation = res.headers.get("Deprecation");
  if (!deprecation) return;
  const link = res.headers.get("Link");
  logger.warn(UPSTREAM_DEPRECATION_LOG_MSG, {
    deprecation,
    link: link ?? undefined,
    method: context.method,
    path: context.path,
  });
}

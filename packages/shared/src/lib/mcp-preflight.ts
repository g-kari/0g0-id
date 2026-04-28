/**
 * mcp worker デプロイ前のプリフライトチェック（issue #236）
 *
 * 現時点で mcp worker には wrangler secret が存在しないため、
 * secret チェックは行わず SKIP_PREFLIGHT の尊重とログ出力のみを担う。
 *
 * 将来 secret が追加された場合は `preflight-core.ts` の `runPreflightCore` を
 * 使って BFF / id と同じパターンで拡張できる。
 */

import type { PreflightRunner } from "./preflight-core";

export type { PreflightRunner };

export type McpPreflightOutcome = { readonly kind: "skipped" } | { readonly kind: "ok" };

/**
 * mcp worker 用プリフライト。
 *
 * 現在チェック対象の secret はないため、SKIP_PREFLIGHT の判定と
 * 「チェック対象なし」のログ出力のみを行う。
 */
export function runMcpPreflight(workerName: string, runner: PreflightRunner): McpPreflightOutcome {
  if (runner.getEnv("SKIP_PREFLIGHT") === "1") {
    runner.log(`[preflight:${workerName}] SKIP_PREFLIGHT=1 — skipping preflight check`);
    return { kind: "skipped" };
  }

  runner.log(`[preflight:${workerName}] No secrets to verify. Preflight passed.`);
  return { kind: "ok" };
}

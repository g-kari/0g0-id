/// <reference types="node" />
/**
 * mcp worker デプロイ前のプリフライトチェック（issue #236）
 *
 * 現在 mcp worker には wrangler secret が存在しないため、
 * 他 worker との統一性のためにスクリプト枠のみ用意する。
 *
 * 終了コード:
 *   - 0: 常に成功（チェック対象の secret がないため）
 *
 * skip 方法: `SKIP_PREFLIGHT=1 npm run deploy`
 *
 * 実行: `tsx scripts/preflight-deploy.ts`（`npm run deploy` から自動起動）
 */

import {
  runMcpPreflight,
  type PreflightRunner,
} from "../../../packages/shared/src/lib/mcp-preflight";

const WORKER_NAME = "mcp";

const runner: PreflightRunner = {
  runWranglerSecretList: () => ({ ok: true, stdout: "[]" }),
  getEnv: (key) => process.env[key],
  // eslint-disable-next-line no-console
  log: (msg) => console.log(msg),
  // eslint-disable-next-line no-console
  warn: (msg) => console.warn(msg),
  // eslint-disable-next-line no-console
  error: (msg) => console.error(msg),
};

runMcpPreflight(WORKER_NAME, runner);

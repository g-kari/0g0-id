/**
 * id worker デプロイ前のプリフライトチェック（issue #156 Phase 7）
 *
 * `INTERNAL_SECRET_STRICT` が wrangler secret として登録されているかだけを
 * 確認し、未登録なら警告する。値そのものは wrangler secret list では見えない
 * ため値検査はしない（runtime 側の `isInternalSecretStrict` で "true" 正規化済み）。
 *
 * 終了コード:
 *   - 0: 設定済み、または未設定かつ `PREFLIGHT_STRICT` が "1" ではない、または wrangler 実行失敗（fail-open）
 *   - 1: 未設定 + `PREFLIGHT_STRICT=1`
 *
 * skip 方法: `SKIP_PREFLIGHT=1 npm run deploy`
 *
 * 実行: `tsx scripts/preflight-deploy.ts`（`npm run deploy` から自動起動）
 */

import { spawnSync } from "node:child_process";
import {
  runInternalSecretStrictPreflight,
  type PreflightRunner,
} from "../../../packages/shared/src/lib/id-preflight";

const WORKER_NAME = "id";

const runner: PreflightRunner = {
  runWranglerSecretList: () => {
    const result = spawnSync("npx", ["wrangler", "secret", "list", "--format=json"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status === 0) {
      return { ok: true, stdout: result.stdout };
    }
    return { ok: false, exitCode: result.status, stderr: result.stderr ?? "" };
  },
  getEnv: (key) => process.env[key],
  // eslint-disable-next-line no-console
  log: (msg) => console.log(msg),
  // eslint-disable-next-line no-console
  warn: (msg) => console.warn(msg),
  // eslint-disable-next-line no-console
  error: (msg) => console.error(msg),
};

const outcome = runInternalSecretStrictPreflight(WORKER_NAME, runner);
// `runInternalSecretStrictPreflight` は純粋関数として設計されており process.exit しないので、
// エントリポイント側で outcome を見て exit する。
if (outcome.kind === "missing-strict") {
  process.exit(1);
}

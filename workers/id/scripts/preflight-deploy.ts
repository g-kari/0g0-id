/**
 * id worker デプロイ前のプリフライトチェック
 *
 * `INTERNAL_SERVICE_SECRET_USER` / `_ADMIN` が登録されているか確認する。
 * 片方でも未登録だと該当 BFF のすべての内部呼び出しが 403 で落ちる。
 *
 * 値そのものは wrangler 側で隠蔽されるため「名前が登録されているか」だけを見る。
 *
 * 終了コード:
 *   - 0: すべて登録済み、または未登録かつ `PREFLIGHT_STRICT` が "1" ではない、または wrangler 実行失敗（fail-open）
 *   - 1: いずれかが未登録 + `PREFLIGHT_STRICT=1`
 *
 * skip 方法: `SKIP_PREFLIGHT=1 npm run deploy`
 *
 * 実行: `tsx scripts/preflight-deploy.ts`（`npm run deploy` から自動起動）
 */

import { spawnSync } from "node:child_process";
import {
  runBffIndividualSecretsPreflight,
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

const bffOutcome = runBffIndividualSecretsPreflight(WORKER_NAME, runner);

if (bffOutcome.kind === "missing-strict") {
  process.exit(1);
}

/**
 * id worker デプロイ前のプリフライトチェック
 *
 * 2 つの独立したチェックを順次実行する:
 *
 * 1. `INTERNAL_SECRET_STRICT` 登録確認（issue #156 Phase 7）
 *    共有 `INTERNAL_SERVICE_SECRET` 経路を 403 で拒否する strict モードが、意図した通り
 *    secret 登録されているかを確認する。未登録だと「strict 化したつもりで warn-only のまま
 *    本番が走る」事故（Phase 6 の裏返し）になる。
 *
 * 2. `INTERNAL_SERVICE_SECRET_USER` / `_ADMIN` 登録確認（issue #156 Phase 8）
 *    strict モード有効時は共有シークレットが 403 拒否されるため、個別シークレットが
 *    片方でも未登録だと、該当 BFF のすべての内部呼び出しが落ちる。
 *    両方が登録されていることを確認して、strict 化の安全弁を担保する。
 *
 * 値そのものは wrangler 側で隠蔽されるため、どのチェックも「名前が登録されているか」だけを見る。
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

// 2 つのチェックは独立。片方が strict abort 要求を出しても、もう片方の warn/error メッセージも
// オペレータには見える必要がある（「どっちが原因か」切り分け効率化）ので必ず両方実行してから exit する。
const strictOutcome = runInternalSecretStrictPreflight(WORKER_NAME, runner);
const bffOutcome = runBffIndividualSecretsPreflight(WORKER_NAME, runner);

if (strictOutcome.kind === "missing-strict" || bffOutcome.kind === "missing-strict") {
  process.exit(1);
}

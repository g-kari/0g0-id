/**
 * BFF デプロイ前の secret プリフライトチェック（issue #155 DBSC Phase 3）
 *
 * `DBSC_ENFORCE_SENSITIVE` は BFF 側の機密操作で DBSC 未バインドセッションを
 * 403 で拒否するかどうかを決める運用スイッチ。未設定だと warn-only にフォールバック
 * するため、「知らずに本番で警告だけ出続ける」事態を防ぎたい。
 *
 * 本モジュールは wrangler secret の列挙結果を入力に取り、DBSC_ENFORCE_SENSITIVE
 * の配備状況を分類する純粋関数を提供する。エントリポイント（workers/*​/scripts/
 * preflight-deploy.ts）が wrangler CLI から値を取って分類結果を人間可読な
 * メッセージに整形する。
 *
 * 汎用部（`PreflightRunner` / `parseWranglerSecretList` / strict/skip 判定）は
 * `preflight-core.ts` に抽出済み。本モジュールは DBSC 向けのラッパとして機能する。
 */

import {
  type PreflightConfig,
  type PreflightOutcome,
  type PreflightRunner,
  type PreflightSecretStatus,
  type SecretListEntry,
  runPreflightCore,
} from "./preflight-core";

export type { PreflightOutcome, PreflightRunner, SecretListEntry };
export { parseWranglerSecretList } from "./preflight-core";

export const DBSC_ENFORCE_SECRET_NAME = "DBSC_ENFORCE_SENSITIVE" as const;

/**
 * secret の配備状況。既存 API 互換のため core 型のエイリアスとして公開する。
 * - `configured`: secret 名が列挙結果に含まれていた（値の中身は wrangler 側で隠蔽される）
 * - `missing`: secret が登録されていない → warn-only モード相当で本番運用される
 */
export type DbscSecretStatus = PreflightSecretStatus;

/**
 * secret 名の列挙から DBSC_ENFORCE_SENSITIVE の配備状況を分類する。
 *
 * 不正な形（null や非文字列）が混じっても落ちないように防御的にフィルタする。
 */
export function classifyDbscSecret(entries: readonly SecretListEntry[]): DbscSecretStatus {
  const configured = entries.some(
    (entry) => typeof entry?.name === "string" && entry.name === DBSC_ENFORCE_SECRET_NAME,
  );
  if (configured) {
    return { kind: "configured", level: "info" };
  }
  return { kind: "missing", level: "warn" };
}

/**
 * 分類結果を 1 行のログ向け文字列に整形する。
 * worker 名を冒頭に入れて user/admin どちらの出力か識別できるようにする。
 */
export function formatDbscStatus(workerName: string, status: DbscSecretStatus): string {
  if (status.kind === "configured") {
    return `[preflight:${workerName}] ${DBSC_ENFORCE_SECRET_NAME} secret is configured. Runtime value controls enforce vs warn-only.`;
  }
  return `[preflight:${workerName}] ${DBSC_ENFORCE_SECRET_NAME} secret is NOT configured. DBSC enforcement falls back to warn-only. Set the secret explicitly (\`wrangler secret put ${DBSC_ENFORCE_SECRET_NAME}\`) — the runtime treats values matching /^true$/i (trimmed, case-insensitive) as enforce; anything else keeps warn-only mode.`;
}

const DBSC_PREFLIGHT_CONFIG: PreflightConfig = {
  secretName: DBSC_ENFORCE_SECRET_NAME,
  classify: classifyDbscSecret,
  format: formatDbscStatus,
};

/**
 * DBSC プリフライトのエントリポイント。既存呼び出し元（workers/{user,admin}/scripts）の
 * シグネチャ互換を保つため 2 引数ラッパを提供し、内部では `runPreflightCore` に委譲する。
 */
export function runPreflight(workerName: string, runner: PreflightRunner): PreflightOutcome {
  return runPreflightCore(workerName, runner, DBSC_PREFLIGHT_CONFIG);
}

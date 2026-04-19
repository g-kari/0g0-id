/**
 * id worker デプロイ前の secret プリフライトチェック（issue #156 Phase 7）
 *
 * `INTERNAL_SECRET_STRICT` は id worker 側の共有 `INTERNAL_SERVICE_SECRET` 経路を
 * `403 DEPRECATED_INTERNAL_SECRET` で拒否する運用スイッチ（Phase 6 で導入）。
 * 未設定だと従来通り warn-only のまま通過してしまうため、「strict 化したつもりで
 * ネストのまま本番が走る」事態を検知可能にする。
 *
 * 汎用部（`PreflightRunner` / `parseWranglerSecretList` / strict/skip 判定）は
 * `preflight-core.ts` に抽出済み。本モジュールは INTERNAL_SECRET_STRICT 向けの
 * 薄いラッパとして機能する。`bff-preflight.ts` と同じ構造・同じ受理値規則
 * （`"true"` / `/^true$/i`）に揃えており、secret 管理者が「どのフラグも同じ値で on に
 * なる」と覚えられるようにしている（`parseStrictBoolEnv` / `isInternalSecretStrict`
 * と単一ソース化）。
 */

import {
  type PreflightConfig,
  type PreflightOutcome,
  type PreflightRunner,
  type PreflightSecretStatus,
  type SecretListEntry,
  runPreflightCore,
} from "./preflight-core";

// 既存 BFF プリフライトと同じく、呼び出し元のエントリポイントが単一ファイル import で
// runner 実装まで完結できるようにコア型を re-export する。
export type { PreflightOutcome, PreflightRunner, SecretListEntry };
export { parseWranglerSecretList } from "./preflight-core";

export const INTERNAL_SECRET_STRICT_NAME = "INTERNAL_SECRET_STRICT" as const;

/**
 * secret の配備状況。既存 DBSC 向けと形状を揃える。
 * - `configured`: secret 名が列挙結果に含まれていた（値の中身は wrangler 側で隠蔽される）
 * - `missing`: secret が登録されていない → 従来通り warn-only モードで共有シークレット経路も 200 通過
 */
export type InternalSecretStrictStatus = PreflightSecretStatus;

/**
 * secret 名の列挙から INTERNAL_SECRET_STRICT の配備状況を分類する。
 *
 * 不正な形（null や非文字列）が混じっても落ちないように防御的にフィルタする。
 */
export function classifyInternalSecretStrictSecret(
  entries: readonly SecretListEntry[],
): InternalSecretStrictStatus {
  const configured = entries.some(
    (entry) => typeof entry?.name === "string" && entry.name === INTERNAL_SECRET_STRICT_NAME,
  );
  if (configured) {
    return { kind: "configured", level: "info" };
  }
  return { kind: "missing", level: "warn" };
}

/**
 * 分類結果を 1 行のログ向け文字列に整形する。
 * worker 名を冒頭に入れて出力元（通常は `id`）を識別できるようにする。
 */
export function formatInternalSecretStrictStatus(
  workerName: string,
  status: InternalSecretStrictStatus,
): string {
  if (status.kind === "configured") {
    return `[preflight:${workerName}] ${INTERNAL_SECRET_STRICT_NAME} secret is configured. Runtime value controls strict (reject shared INTERNAL_SERVICE_SECRET) vs warn-only.`;
  }
  return `[preflight:${workerName}] ${INTERNAL_SECRET_STRICT_NAME} secret is NOT configured. Shared INTERNAL_SERVICE_SECRET path still accepted (warn-only). Set the secret explicitly (\`wrangler secret put ${INTERNAL_SECRET_STRICT_NAME}\`) — the runtime treats values matching /^true$/i (trimmed, case-insensitive) as strict; anything else keeps warn-only mode.`;
}

const INTERNAL_SECRET_STRICT_PREFLIGHT_CONFIG: PreflightConfig = {
  secretName: INTERNAL_SECRET_STRICT_NAME,
  classify: classifyInternalSecretStrictSecret,
  format: formatInternalSecretStrictStatus,
};

/**
 * id worker 向けプリフライトのエントリポイント。
 * `workers/id/scripts/preflight-deploy.ts` から呼ばれ、内部では `runPreflightCore` に委譲する。
 */
export function runInternalSecretStrictPreflight(
  workerName: string,
  runner: PreflightRunner,
): PreflightOutcome {
  return runPreflightCore(workerName, runner, INTERNAL_SECRET_STRICT_PREFLIGHT_CONFIG);
}

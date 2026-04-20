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
  parseWranglerSecretList,
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

/**
 * BFF 毎の個別シークレット名（issue #156 Phase 8）。
 *
 * Phase 1 で導入された `INTERNAL_SERVICE_SECRET_USER` / `_ADMIN` は、共有
 * `INTERNAL_SERVICE_SECRET` を撤廃する過程で BFF ごとの漏洩影響範囲を局所化するために
 * 使う。strict モード（`INTERNAL_SECRET_STRICT=true`）で共有シークレット経路が 403 に
 * 落ちるため、strict 化前に両方が登録されていることを preflight で確認できないと、
 * 片方の BFF が全面的に落ちる事故が起きうる。
 */
export const INTERNAL_SERVICE_SECRET_USER_NAME = "INTERNAL_SERVICE_SECRET_USER" as const;
export const INTERNAL_SERVICE_SECRET_ADMIN_NAME = "INTERNAL_SERVICE_SECRET_ADMIN" as const;

/**
 * 個別 BFF シークレットの登録状況。
 */
export interface BffIndividualSecretsStatus {
  readonly userConfigured: boolean;
  readonly adminConfigured: boolean;
}

/**
 * 個別 BFF シークレット（USER / ADMIN）の登録状況を分類する。
 * 不正な形（null や非文字列）が混じっても落ちないように防御的にフィルタする。
 */
export function classifyBffIndividualSecrets(
  entries: readonly SecretListEntry[],
): BffIndividualSecretsStatus {
  const names = new Set<string>();
  for (const entry of entries) {
    if (typeof entry?.name === "string") names.add(entry.name);
  }
  return {
    userConfigured: names.has(INTERNAL_SERVICE_SECRET_USER_NAME),
    adminConfigured: names.has(INTERNAL_SERVICE_SECRET_ADMIN_NAME),
  };
}

/**
 * 個別 BFF シークレットの登録状況を 1 行のログ向け文字列に整形する。
 */
export function formatBffIndividualSecretsStatus(
  workerName: string,
  status: BffIndividualSecretsStatus,
): string {
  const missing: string[] = [];
  if (!status.userConfigured) missing.push(INTERNAL_SERVICE_SECRET_USER_NAME);
  if (!status.adminConfigured) missing.push(INTERNAL_SERVICE_SECRET_ADMIN_NAME);
  if (missing.length === 0) {
    return `[preflight:${workerName}] Individual BFF secrets (${INTERNAL_SERVICE_SECRET_USER_NAME}, ${INTERNAL_SERVICE_SECRET_ADMIN_NAME}) are both configured. Shared INTERNAL_SERVICE_SECRET path can be safely rejected via INTERNAL_SECRET_STRICT.`;
  }
  return `[preflight:${workerName}] Individual BFF secrets NOT fully configured. Missing: ${missing.join(", ")}. If INTERNAL_SECRET_STRICT=true is active, the affected BFF will be rejected at /auth/* with 403 DEPRECATED_INTERNAL_SECRET. Register both via \`wrangler secret put ${missing.join(" && wrangler secret put ")}\` before enabling strict mode.`;
}

/**
 * 個別 BFF シークレット（USER/ADMIN）の preflight 結果。
 * 共有 secret strict の結果と同じく `PreflightOutcome` 互換にしつつ、
 * どの secret が未登録なのかを追跡できるよう `missing` を付加する。
 */
export type BffIndividualSecretsOutcome =
  | { readonly kind: "skipped" }
  | { readonly kind: "wrangler-failed"; readonly exitCode: number | null }
  | { readonly kind: "parse-failed"; readonly reason: string }
  | { readonly kind: "configured" }
  | { readonly kind: "missing-warn"; readonly missing: readonly string[] }
  | { readonly kind: "missing-strict"; readonly missing: readonly string[] };

/**
 * 個別 BFF シークレット用のプリフライトエントリポイント（issue #156 Phase 8）。
 *
 * 共有 secret strict の preflight と異なり、2 つの secret を同時に確認する。
 * 片方だけ欠けていても（USER だけ設定 / ADMIN 未設定 等）warn または strict abort になる。
 * wrangler secret list を独立に 1 回呼ぶ（deploy 前の 1 度限りの実行なのでコスト無視）。
 *
 * skip / strict 判定は `runInternalSecretStrictPreflight` と同じ規則。
 */
export function runBffIndividualSecretsPreflight(
  workerName: string,
  runner: PreflightRunner,
): BffIndividualSecretsOutcome {
  if (runner.getEnv("SKIP_PREFLIGHT") === "1") {
    runner.log(
      `[preflight:${workerName}] SKIP_PREFLIGHT=1 — skipping individual BFF secrets check`,
    );
    return { kind: "skipped" };
  }

  const result = runner.runWranglerSecretList();
  if (!result.ok) {
    runner.warn(
      `[preflight:${workerName}] wrangler secret list failed (exit ${result.exitCode ?? "null"}). Skipping individual BFF secrets check.`,
    );
    const trimmed = result.stderr.trim();
    if (trimmed) runner.warn(`[preflight:${workerName}] stderr: ${trimmed}`);
    return { kind: "wrangler-failed", exitCode: result.exitCode };
  }

  let entries: SecretListEntry[];
  try {
    entries = parseWranglerSecretList(result.stdout);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    runner.warn(
      `[preflight:${workerName}] could not parse wrangler secret list output for individual BFF secrets check: ${reason}`,
    );
    return { kind: "parse-failed", reason };
  }

  const status = classifyBffIndividualSecrets(entries);
  const message = formatBffIndividualSecretsStatus(workerName, status);
  const missing: string[] = [];
  if (!status.userConfigured) missing.push(INTERNAL_SERVICE_SECRET_USER_NAME);
  if (!status.adminConfigured) missing.push(INTERNAL_SERVICE_SECRET_ADMIN_NAME);

  if (missing.length === 0) {
    runner.log(message);
    return { kind: "configured" };
  }

  runner.warn(message);
  const strictRaw = runner.getEnv("PREFLIGHT_STRICT");
  if (strictRaw === "1") {
    runner.error(
      `[preflight:${workerName}] PREFLIGHT_STRICT=1: aborting deploy because individual BFF secrets are incomplete (missing: ${missing.join(", ")}).`,
    );
    return { kind: "missing-strict", missing };
  }
  if (strictRaw !== undefined && strictRaw !== "") {
    runner.warn(
      `[preflight:${workerName}] PREFLIGHT_STRICT=${JSON.stringify(strictRaw)} is not "1"; strict mode was NOT applied. Use PREFLIGHT_STRICT=1 to abort on missing individual BFF secret.`,
    );
  }
  return { kind: "missing-warn", missing };
}

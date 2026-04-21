/**
 * id worker デプロイ前の secret プリフライトチェック（issue #156 Phase 8-9）
 *
 * `INTERNAL_SERVICE_SECRET_USER` / `_ADMIN` が両方登録されていることを確認する。
 * 片方でも未登録だと該当 BFF のすべての内部呼び出しが 403 で落ちる。
 *
 * 汎用部（`PreflightRunner` / `parseWranglerSecretList` / strict/skip 判定）は
 * `preflight-core.ts` に抽出済み。
 */

import {
  type PreflightOutcome,
  type PreflightRunner,
  type SecretListEntry,
  parseWranglerSecretList,
} from "./preflight-core";

export type { PreflightOutcome, PreflightRunner, SecretListEntry };
export { parseWranglerSecretList } from "./preflight-core";

/**
 * BFF 毎の個別シークレット名。
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
    return `[preflight:${workerName}] Individual BFF secrets (${INTERNAL_SERVICE_SECRET_USER_NAME}, ${INTERNAL_SERVICE_SECRET_ADMIN_NAME}) are both configured.`;
  }
  return `[preflight:${workerName}] Individual BFF secrets NOT fully configured. Missing: ${missing.join(", ")}. The affected BFF will be rejected at /auth/* with 403. Register both via \`wrangler secret put ${missing.join(" && wrangler secret put ")}\`.`;
}

/**
 * 個別 BFF シークレット（USER/ADMIN）の preflight 結果。
 */
export type BffIndividualSecretsOutcome =
  | { readonly kind: "skipped" }
  | { readonly kind: "wrangler-failed"; readonly exitCode: number | null }
  | { readonly kind: "parse-failed"; readonly reason: string }
  | { readonly kind: "configured" }
  | { readonly kind: "missing-warn"; readonly missing: readonly string[] }
  | { readonly kind: "missing-strict"; readonly missing: readonly string[] };

/**
 * 個別 BFF シークレット用のプリフライトエントリポイント。
 *
 * 2 つの secret を同時に確認する。片方だけ欠けていても warn または strict abort になる。
 *
 * skip / strict 判定規則:
 * - `SKIP_PREFLIGHT=1`: 全チェックをスキップ
 * - `PREFLIGHT_STRICT=1`: 未登録時に exit 1 で abort
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

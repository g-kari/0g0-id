/**
 * デプロイ前の wrangler secret 登録チェック用の汎用コア。
 *
 * worker ごとの個別プリフライト（例: `bff-preflight.ts` の `DBSC_ENFORCE_SENSITIVE`、
 * `id-preflight.ts` の `INTERNAL_SECRET_STRICT`）は、secret 名と人間可読メッセージのみ
 * が異なり、入力パース・strict/skip/fail-open 判定・ログ出力フローは完全に共通。
 * 本モジュールはその共通部を純粋関数 + runner DI として提供し、各プリフライトは
 * 薄いラッパに集約できるようにする。
 */

/**
 * wrangler の secret list 出力に含まれる可能性のある最小形状。
 * 実際は `{ name: string, type: "secret_text" }` が返るが、name だけを契約とする。
 */
export interface SecretListEntry {
  readonly name: string;
}

/**
 * 個別プリフライトの secret ステータス。
 * 各ラッパで kind を広げず `configured` / `missing` の 2 値に絞ることで、
 * core 側の strict / skip 判定を単純に保つ。
 */
export type PreflightSecretStatus =
  | { readonly kind: "configured"; readonly level: "info" }
  | { readonly kind: "missing"; readonly level: "warn" };

/**
 * 個別プリフライトの構成。`secretName` は未登録時のエラーメッセージに使う。
 * `classify` は wrangler 側の列挙結果を `PreflightSecretStatus` に畳み込む純粋関数、
 * `format` は status を人間可読な 1 行ログ文字列に整形する。
 */
export interface PreflightConfig {
  readonly secretName: string;
  readonly classify: (entries: readonly SecretListEntry[]) => PreflightSecretStatus;
  readonly format: (workerName: string, status: PreflightSecretStatus) => string;
}

/**
 * wrangler CLI の `secret list --format=json` 出力をパースする。
 * 壊れた JSON や配列でない値はエラーを投げる（呼び出し側で握りつぶし禁止）。
 */
export function parseWranglerSecretList(raw: string): SecretListEntry[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("wrangler secret list output is not a JSON array");
  }
  return parsed.filter(
    (entry): entry is SecretListEntry =>
      typeof entry === "object" &&
      entry !== null &&
      "name" in entry &&
      typeof (entry as { name: unknown }).name === "string",
  );
}

/**
 * スクリプトエントリポイントの入出力を抽象化するインターフェース。
 * テストから spawnSync や process を差し替えられるようにする。
 */
export interface PreflightRunner {
  /** wrangler secret list 相当を実行して raw JSON 文字列を返す。失敗時は exitCode と stderr を返す */
  runWranglerSecretList: () =>
    | { ok: true; stdout: string }
    | { ok: false; exitCode: number | null; stderr: string };
  /** 環境変数を取得する */
  getEnv: (key: string) => string | undefined;
  /** ログ出力 */
  log: (message: string) => void;
  /** 警告出力 */
  warn: (message: string) => void;
  /** エラー出力（通常 stderr） */
  error: (message: string) => void;
}

/**
 * プリフライト実行結果。
 * - `skipped`: `SKIP_PREFLIGHT=1` で明示的に無効化された
 * - `wrangler-failed`: wrangler CLI 実行に失敗した（認証未了・未インストール等）
 * - `parse-failed`: 出力 JSON のパースに失敗した
 * - `configured`: 対象 secret が登録済み
 * - `missing-warn`: 未登録だが strict ではないので警告のみ
 * - `missing-strict`: 未登録 + PREFLIGHT_STRICT=1 で abort 要求
 */
export type PreflightOutcome =
  | { readonly kind: "skipped" }
  | { readonly kind: "wrangler-failed"; readonly exitCode: number | null }
  | { readonly kind: "parse-failed"; readonly reason: string }
  | { readonly kind: "configured" }
  | { readonly kind: "missing-warn" }
  | { readonly kind: "missing-strict" };

/**
 * プリフライトのコアロジック。
 *
 * 副作用は `runner.log`/`warn`/`error` 経由のみに限定し、process.exit はしない
 * （呼び出し側のエントリポイントで `outcome.kind === "missing-strict"` を見て exit する）。
 *
 * skip / strict 判定の挙動:
 * - `SKIP_PREFLIGHT=1` が最優先。strict が併設されていても skip する。
 * - `PREFLIGHT_STRICT=1` のみが strict を有効化（`"true"` / `"yes"` は不可）。secret 管理者の
 *   設定ミスで strict を黙って外さないため、`"1"` 以外の非空値は「strict が適用されなかった」
 *   旨の独立 warn を出す。
 */
export function runPreflightCore(
  workerName: string,
  runner: PreflightRunner,
  config: PreflightConfig,
): PreflightOutcome {
  if (runner.getEnv("SKIP_PREFLIGHT") === "1") {
    runner.log(`[preflight:${workerName}] SKIP_PREFLIGHT=1 — skipping secret check`);
    return { kind: "skipped" };
  }

  const result = runner.runWranglerSecretList();
  if (!result.ok) {
    runner.warn(
      `[preflight:${workerName}] wrangler secret list failed (exit ${result.exitCode ?? "null"}). Skipping ${config.secretName} check.`,
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
    runner.warn(`[preflight:${workerName}] could not parse wrangler secret list output: ${reason}`);
    return { kind: "parse-failed", reason };
  }

  const status = config.classify(entries);
  const message = config.format(workerName, status);

  if (status.kind === "configured") {
    runner.log(message);
    return { kind: "configured" };
  }

  runner.warn(message);
  const strictRaw = runner.getEnv("PREFLIGHT_STRICT");
  if (strictRaw === "1") {
    runner.error(
      `[preflight:${workerName}] PREFLIGHT_STRICT=1: aborting deploy because ${config.secretName} is not configured.`,
    );
    return { kind: "missing-strict" };
  }
  if (strictRaw !== undefined && strictRaw !== "") {
    runner.warn(
      `[preflight:${workerName}] PREFLIGHT_STRICT=${JSON.stringify(strictRaw)} is not "1"; strict mode was NOT applied. Use PREFLIGHT_STRICT=1 to abort on missing secret.`,
    );
  }
  return { kind: "missing-warn" };
}

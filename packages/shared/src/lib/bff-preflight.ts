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
 */

export const DBSC_ENFORCE_SECRET_NAME = "DBSC_ENFORCE_SENSITIVE" as const;

/**
 * secret の配備状況。
 * - `configured`: secret 名が列挙結果に含まれていた（値の中身は wrangler 側で隠蔽される）
 * - `missing`: secret が登録されていない → warn-only モード相当で本番運用される
 */
export type DbscSecretStatus =
  | { readonly kind: "configured"; readonly level: "info" }
  | { readonly kind: "missing"; readonly level: "warn" };

/**
 * wrangler の secret list 出力に含まれる可能性のある最小形状。
 * 実際は `{ name: string, type: "secret_text" }` が返るが、name だけを契約とする。
 */
export interface SecretListEntry {
  readonly name: string;
}

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
 * - `configured`: DBSC_ENFORCE_SENSITIVE が登録済み
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
 * プリフライトのコアロジック。workers/user/scripts と workers/admin/scripts から呼ばれる。
 * 副作用は `runner.log`/`warn`/`error` 経由のみに限定し、process.exit はしない
 * （呼び出し側で `outcome.kind === "missing-strict"` を見て exit する）。
 */
export function runPreflight(workerName: string, runner: PreflightRunner): PreflightOutcome {
  if (runner.getEnv("SKIP_PREFLIGHT") === "1") {
    runner.log(`[preflight:${workerName}] SKIP_PREFLIGHT=1 — skipping secret check`);
    return { kind: "skipped" };
  }

  const result = runner.runWranglerSecretList();
  if (!result.ok) {
    runner.warn(
      `[preflight:${workerName}] wrangler secret list failed (exit ${result.exitCode ?? "null"}). Skipping DBSC secret check.`,
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

  const status = classifyDbscSecret(entries);
  const message = formatDbscStatus(workerName, status);

  if (status.kind === "configured") {
    runner.log(message);
    return { kind: "configured" };
  }

  runner.warn(message);
  const strictRaw = runner.getEnv("PREFLIGHT_STRICT");
  if (strictRaw === "1") {
    runner.error(
      `[preflight:${workerName}] PREFLIGHT_STRICT=1: aborting deploy because ${DBSC_ENFORCE_SECRET_NAME} is not configured.`,
    );
    return { kind: "missing-strict" };
  }
  // PREFLIGHT_STRICT は厳密比較 "1" のみ有効。`"true"` や `"yes"` のような
  // 似ている値を設定したオペレータが「strict に設定したつもり」で通過するのを
  // 防ぐために、未定義・空文字でない別値が来たら独立した警告を出す。
  if (strictRaw !== undefined && strictRaw !== "") {
    runner.warn(
      `[preflight:${workerName}] PREFLIGHT_STRICT=${JSON.stringify(strictRaw)} is not "1"; strict mode was NOT applied. Use PREFLIGHT_STRICT=1 to abort on missing secret.`,
    );
  }
  return { kind: "missing-warn" };
}

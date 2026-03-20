/**
 * サービスの allowed_scopes JSON 文字列をパースして文字列配列に変換する。
 *
 * - JSON パース失敗、または配列でない値の場合はフェイルクローズド（空配列）を返す。
 * - 壊れた設定値でユーザーデータを誤って公開しないための安全策。
 */
export function parseAllowedScopes(allowedScopesJson: string): string[] {
  try {
    const scopes = JSON.parse(allowedScopesJson) as unknown;
    return Array.isArray(scopes) ? (scopes as string[]) : [];
  } catch {
    return [];
  }
}

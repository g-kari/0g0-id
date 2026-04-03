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

/**
 * リクエストされたスコープをサービスの許可スコープでフィルタリングし、
 * 有効なスコープ文字列を返す。
 *
 * - requestedScope が指定されている場合: openid + 許可スコープに含まれるもののみ残す
 * - requestedScope が未指定の場合: openid + 全許可スコープをデフォルトとして返す
 */
export function resolveEffectiveScope(
  requestedScope: string | null | undefined,
  allowedScopesJson: string
): string | undefined {
  const allowedScopes = parseAllowedScopes(allowedScopesJson);
  if (requestedScope) {
    const requested = requestedScope.split(' ').filter(Boolean);
    const valid = requested.filter((s) => s === 'openid' || allowedScopes.includes(s));
    return valid.length > 0 ? valid.join(' ') : undefined;
  }
  return ['openid', ...allowedScopes].join(' ');
}

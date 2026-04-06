/**
 * サービスの allowed_scopes JSON 文字列をパースして文字列配列に変換する。
 *
 * - JSON パース失敗、または配列でない値の場合はフェイルクローズド（空配列）を返す。
 * - 壊れた設定値でユーザーデータを誤って公開しないための安全策。
 * - スコープトークンとして許可する文字（RFC 6749 §3.3 準拠、実用的に制限）
 */
const VALID_SCOPE_RE = /^[\w:.\-]+$/;

export function parseAllowedScopes(allowedScopesJson: string): string[] {
  try {
    const scopes = JSON.parse(allowedScopesJson) as unknown;
    if (!Array.isArray(scopes)) return [];
    // 各要素がstringかつ有効な文字のみで構成されているものだけ残す（空白・制御文字を除外）
    return scopes.filter((s): s is string => typeof s === 'string' && VALID_SCOPE_RE.test(s));
  } catch {
    return [];
  }
}

/**
 * リクエストされたスコープをサービスの許可スコープでフィルタリングし、
 * 有効なスコープ文字列を返す。
 *
 * - requestedScope が指定されている場合: openid + 許可スコープに含まれるもののみ残す
 * - requestedScope が未指定の場合: 最小スコープポリシー（RFC 6749 §3.3）に従い openid のみを返す
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
  return 'openid';
}

/**
 * OIDC nonce パラメータのバリデーションを行い、エラーメッセージを返す。
 * 問題なければ null を返す。
 *
 * - undefined の場合はバリデーションをスキップ（OIDCオプションパラメータ）
 * - 128文字超は拒否
 * - 制御文字（U+0000〜U+001F, U+007F）を含む場合は拒否（OIDC Core 1.0 §3.1.2.1）
 */
export function validateNonce(nonce: string | undefined): string | null {
  if (nonce === undefined) return null;
  if (nonce.length > 128) return 'nonce too long';
  if (/[\x00-\x1F\x7F]/.test(nonce)) return 'nonce contains invalid characters';
  return null;
}

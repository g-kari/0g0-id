/**
 * RFC 8707 リソース束縛トークンのスコープを計算する。
 *
 * リソースサーバー側の登録スコープ（resource_servers.allowed_scopes）が
 * そのリソースで付与できる権限の上限になる。クライアントの
 * allowed_scopes とは独立に、リソース登録時に管理者が許可した範囲だけが
 * 有効になる（DCR で自己登録したクライアントでも、リソース側の登録が
 * なければ resource 向けスコープは一切付与されない）。
 *
 * - requestedScope がある場合: リソースの許可スコープに含まれるもののみ残す
 * - requestedScope がない場合: resource スコープは付与しない（undefined）。
 *   省略を理由にリソースの全スコープを既定付与することはしない
 *   （resource スコープは明示的に要求されたものだけが付与される）。
 * - 有効なスコープが残らない場合は undefined（呼び出し側で invalid_scope）
 */
export function resolveResourceScope(
  requestedScope: string | null | undefined,
  resourceAllowedScopesJson: string,
): string | undefined {
  const allowed = parseAllowedScopes(resourceAllowedScopesJson);
  if (allowed.length === 0) return undefined;
  if (!requestedScope) return undefined;
  const requested = requestedScope.split(" ").filter(Boolean);
  if (requested.length === 0) return undefined;
  const valid = requested.filter((s) => allowed.includes(s));
  return valid.length > 0 ? valid.join(" ") : undefined;
}

/**
 * resource_servers.allowed_subjects（JSON 配列文字列）をパースする。
 *
 * - 空配列は「制限なし」を表す（parseAllowedSubjects の戻り値も空配列）。
 * - JSON パース失敗・配列でない値・文字列でない要素が混ざる場合は
 *   null を返し、呼び出し側でフェイルクローズドに扱う。
 */
export function parseAllowedSubjects(
  allowedSubjectsJson: string | null | undefined,
): string[] | null {
  if (allowedSubjectsJson == null) return [];
  try {
    const subjects = JSON.parse(allowedSubjectsJson) as unknown;
    if (!Array.isArray(subjects)) return null;
    if (!subjects.every((s): s is string => typeof s === "string" && s.length > 0)) return null;
    return subjects;
  } catch {
    return null;
  }
}

/**
 * リソースサーバーの利用者制限（allowed_subjects）に対して subject を照合する。
 *
 * - allowed_subjects が空（未設定）なら制限なし → 全ユーザーを許可
 * - 設定されている場合は、配列に含まれる subject（ユーザー ID）のみ許可
 * - 壊れた設定値はフェイルクローズド（誰も許可しない）
 */
export function isSubjectAllowedForResource(
  resource: { allowed_subjects?: string | null },
  subject: string,
): boolean {
  const subjects = parseAllowedSubjects(resource.allowed_subjects);
  if (subjects === null) return false;
  if (subjects.length === 0) return true;
  return subjects.includes(subject);
}

/**
 * サービスの allowed_scopes JSON 文字列をパースして文字列配列に変換する。
 *
 * - JSON パース失敗、または配列でない値の場合はフェイルクローズド（空配列）を返す。
 * - 壊れた設定値でユーザーデータを誤って公開しないための安全策。
 * - スコープトークンとして許可する文字（RFC 6749 §3.3 準拠、実用的に制限）
 */
const VALID_SCOPE_RE = /^[\w:.-]+$/;

export function parseAllowedScopes(allowedScopesJson: string): string[] {
  try {
    const scopes = JSON.parse(allowedScopesJson) as unknown;
    if (!Array.isArray(scopes)) return [];
    // 各要素がstringかつ有効な文字のみで構成されているものだけ残す（空白・制御文字を除外）
    return scopes.filter((s): s is string => typeof s === "string" && VALID_SCOPE_RE.test(s));
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
  allowedScopesJson: string,
): string | undefined {
  const allowedScopes = parseAllowedScopes(allowedScopesJson);
  if (requestedScope) {
    const requested = requestedScope.split(" ").filter(Boolean);
    const valid = requested.filter((s) => s === "openid" || allowedScopes.includes(s));
    return valid.length > 0 ? valid.join(" ") : undefined;
  }
  return "openid";
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
  if (nonce.length > 128) return "nonce too long";
  if (/[\x00-\x1F\x7F]/.test(nonce)) return "nonce contains invalid characters";
  return null;
}

/**
 * PKCE code_challenge パラメータのバリデーションを行い、エラーメッセージを返す。
 * 問題なければ null を返す。
 *
 * - undefined の場合はバリデーションをスキップ（オプションパラメータ）
 * - RFC 7636 §4.2: S256 の code_challenge は BASE64URL(SHA256(code_verifier)) = 43文字
 * - 許可文字: [A-Za-z0-9\-_]（BASE64URL アルファベット、パディングなし）
 */
export function validateCodeChallenge(codeChallenge: string | undefined): string | null {
  if (codeChallenge === undefined) return null;
  if (!/^[A-Za-z0-9\-_]{43}$/.test(codeChallenge)) return "Invalid code_challenge format for S256";
  return null;
}

/**
 * code_challenge / code_challenge_method パラメータの整合性を検証する。
 * - code_challenge 指定時: S256 のみ許可 + フォーマット検証
 * - code_challenge_method のみ指定: エラー
 * - 両方未指定: OK（オプショナルなケース）
 */
export function validateCodeChallengeParams(
  codeChallenge: string | undefined,
  codeChallengeMethod: string | undefined,
): string | null {
  if (codeChallenge && codeChallengeMethod !== "S256") {
    return "Only S256 code_challenge_method is supported";
  }
  if (!codeChallenge && codeChallengeMethod !== undefined) {
    return "code_challenge is required when code_challenge_method is specified";
  }
  return validateCodeChallenge(codeChallenge);
}

/**
 * localhost/127.0.0.1 の redirect_uri を比較する。
 * ローカルホストの場合はポート番号を無視して比較する (RFC 8252 §7.3)。
 *
 * ネイティブアプリ（MCPクライアント等）は起動時にランダムポートで
 * ローカルHTTPサーバーを立ち上げるため、登録時のポートと
 * 実際のリクエスト時のポートが異なることがある。
 *
 * localhost と 127.0.0.1 は同一ホストとして扱う (RFC 8252 §8.3 SHOULD)。
 */
export function matchRedirectUri(registered: string, requested: string): boolean {
  let regUrl: URL;
  let reqUrl: URL;
  try {
    regUrl = new URL(registered);
    reqUrl = new URL(requested);
  } catch {
    return false;
  }

  const isLocalhostHost = (hostname: string): boolean =>
    hostname === "localhost" || hostname === "127.0.0.1";

  // 両方がlocalhostの場合はポートを無視して比較
  // localhost と 127.0.0.1 は同一ホストとして扱う (RFC 8252 §8.3)
  if (isLocalhostHost(regUrl.hostname) && isLocalhostHost(reqUrl.hostname)) {
    return (
      regUrl.protocol === reqUrl.protocol &&
      regUrl.pathname === reqUrl.pathname &&
      regUrl.search === reqUrl.search
    );
  }

  // 非localhostの場合は完全一致（ポート含む）
  return registered === requested;
}

/**
 * redirect_uri を正規化する。
 * - fragment禁止（RFC 6749 §3.1.2）
 * - https必須（localhost例外）
 * - host小文字化
 * - 既定ポート除去
 *
 * 不正な場合は null を返す。
 */
export function normalizeRedirectUri(uri: string): string | null {
  try {
    const url = new URL(uri);

    // fragment禁止（空fragmentも含む: `#` 文字自体を禁止）
    if (uri.includes("#")) return null;

    const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";

    // https必須（localhost例外）
    if (!isLocalhost && url.protocol !== "https:") return null;

    // host小文字化
    url.hostname = url.hostname.toLowerCase();

    // 既定ポート除去
    if (
      (url.protocol === "https:" && url.port === "443") ||
      (url.protocol === "http:" && url.port === "80")
    ) {
      url.port = "";
    }

    return url.toString();
  } catch {
    return null;
  }
}

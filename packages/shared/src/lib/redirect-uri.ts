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
    hostname === 'localhost' || hostname === '127.0.0.1';

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

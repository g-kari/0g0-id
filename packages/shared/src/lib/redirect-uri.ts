/**
 * loopback ホストかどうかを判定する。
 *
 * 許可するのは明示した loopback のみ: localhost / 127.0.0.1 / ::1。
 * URL の hostname は IPv6 リテラルでは角括弧つき（"[::1]"）になるため両形式を受ける。
 * loopback だからといって任意 scheme を許すものではなく、http の可否は
 * 呼び出し側（normalizeRedirectUri 等）がこの判定と組み合わせて決める。
 */
export function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

/**
 * localhost/127.0.0.1/::1 の redirect_uri を比較する。
 * ローカルホストの場合はポート番号を無視して比較する (RFC 8252 §7.3)。
 *
 * ネイティブアプリ（MCPクライアント等）は起動時にランダムポートで
 * ローカルHTTPサーバーを立ち上げるため、登録時のポートと
 * 実際のリクエスト時のポートが異なることがある。
 *
 * localhost と 127.0.0.1 と ::1 は同一ホストとして扱う (RFC 8252 §8.3 SHOULD)。
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

  // 両方がloopbackの場合はポートを無視して比較
  // loopback 同士は同一ホストとして扱う (RFC 8252 §8.3)
  if (isLoopbackHost(regUrl.hostname) && isLoopbackHost(reqUrl.hostname)) {
    return (
      regUrl.protocol === reqUrl.protocol &&
      regUrl.pathname === reqUrl.pathname &&
      regUrl.search === reqUrl.search
    );
  }

  // 非loopbackの場合は完全一致（ポート含む）
  return registered === requested;
}

/**
 * redirect_uri を正規化する。
 * - fragment禁止（RFC 6749 §3.1.2）
 * - https必須（loopback の http のみ例外: localhost / 127.0.0.1 / ::1）
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

    const isLocalhost = isLoopbackHost(url.hostname);

    // 許可 scheme は https、または loopback の http のみ。
    // loopback であっても任意 scheme（ftp 等）は許可しない。
    if (url.protocol === "http:") {
      if (!isLocalhost) return null;
    } else if (url.protocol !== "https:") {
      return null;
    }

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

/**
 * ランダムなclient_idを生成する
 */
export function generateClientId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * ランダムなclient_secretを生成する（32バイト = 64文字hex）
 */
export function generateClientSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * SHA-256ハッシュを計算する（WebCrypto）
 */
export async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * ランダムなトークンを生成する（URLセーフbase64）
 */
export function generateToken(byteLength: number = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * PKCE code_verifierを生成する（RFC 7636）
 */
export function generateCodeVerifier(): string {
  return generateToken(32);
}

/**
 * PKCE code_challengeをS256で計算する（RFC 7636）
 */
export async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hashBuffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * 定数時間比較（タイミング攻撃対策）
 * Cloudflare Workers 環境では crypto.subtle.timingSafeEqual（WebCrypto 非標準拡張）を使用し、
 * JITコンパイルによる最適化に左右されない真の定数時間比較を保証する。
 * それ以外の環境（Vitest 等）では TextEncoder でバイト列化した上で
 * XOR ループによる定数時間比較にフォールバックする。
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.length !== bBytes.length) {
    return false;
  }
  // crypto.subtle.timingSafeEqual は Cloudflare Workers / Node.js 19+ で利用可能
  type SubtleCryptoWithTimingSafeEqual = SubtleCrypto & { timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean };
  const subtleCrypto = crypto.subtle as unknown as SubtleCryptoWithTimingSafeEqual;
  if (typeof subtleCrypto.timingSafeEqual === 'function') {
    return subtleCrypto.timingSafeEqual(aBytes.buffer as ArrayBuffer, bBytes.buffer as ArrayBuffer);
  }
  // フォールバック: バイト列に対するXORループ定数時間比較
  let result = 0;
  for (let i = 0; i < aBytes.length; i++) {
    result |= aBytes[i] ^ bBytes[i];
  }
  return result === 0;
}

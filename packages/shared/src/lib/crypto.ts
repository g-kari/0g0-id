/**
 * ランダムなclient_idを生成する
 */
export function generateClientId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * ランダムなclient_secretを生成する（32バイト = 64文字hex）
 */
export function generateClientSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * SHA-256ハッシュを計算する（WebCrypto）
 */
export async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * ペアワイズsub識別子を生成する（OIDC pairwise subject / OIDC Core 1.0 §8.1）
 * salt が指定されている場合は sha256(salt:clientId:userId)、
 * 未指定の場合は sha256(clientId:userId) で後方互換を維持する。
 */
export async function generatePairwiseSub(
  clientId: string,
  userId: string,
  salt?: string,
): Promise<string> {
  const input = salt ? `${salt}:${clientId}:${userId}` : `${clientId}:${userId}`;
  return sha256(input);
}

/**
 * ランダムなトークンを生成する（URLセーフbase64）
 */
export function generateToken(byteLength: number = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
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
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return btoa(Array.from(new Uint8Array(hashBuffer), (b) => String.fromCharCode(b)).join(""))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
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
  // crypto.subtle.timingSafeEqual は Cloudflare Workers / Node.js 19+ で利用可能
  // 長さが一致する場合のみネイティブAPIを使用（ネイティブAPIは長さ不一致でエラーを投げるため）
  type SubtleCryptoWithTimingSafeEqual = SubtleCrypto & {
    timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean;
  };
  const subtleCrypto = crypto.subtle as unknown as SubtleCryptoWithTimingSafeEqual;
  if (typeof subtleCrypto.timingSafeEqual === "function" && aBytes.length === bBytes.length) {
    return subtleCrypto.timingSafeEqual(aBytes.buffer as ArrayBuffer, bBytes.buffer as ArrayBuffer);
  }
  // フォールバック: 長さ差分もXORループで定数時間比較（タイミングリーク防止）
  const maxLen = Math.max(aBytes.length, bBytes.length);
  const aPadded = new Uint8Array(maxLen);
  const bPadded = new Uint8Array(maxLen);
  aPadded.set(aBytes);
  bPadded.set(bBytes);
  let result = aBytes.length === bBytes.length ? 0 : 1;
  for (let i = 0; i < maxLen; i++) {
    result |= aPadded[i] ^ bPadded[i];
  }
  return result === 0;
}

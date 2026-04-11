/**
 * HMAC-SHA256 署名付きCookieユーティリティ
 *
 * 署名形式: `<base64url(payload)>.<base64url(HMAC-SHA256(base64url(payload), secret))>`
 *
 * Cookie改ざん検知のためにサーバー側シークレットで署名する。
 * WebCrypto API（HMAC-SHA256）を使用するため、Cloudflare Workers / Node.js どちらでも動作する。
 */

/**
 * base64url エンコード（Uint8Array → 文字列）
 */
function toBase64Url(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/**
 * base64url デコード（文字列 → Uint8Array）
 */
function fromBase64Url(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (padded.length % 4)) % 4;
  const binary = atob(padded + "=".repeat(pad));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/**
 * HMAC-SHA256 署名鍵をインポートする
 */
async function importHmacKey(secret: string): Promise<CryptoKey> {
  const keyBytes = new TextEncoder().encode(secret);
  return crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/**
 * payload に HMAC-SHA256 署名を付与した署名付きCookie値を返す。
 *
 * @param payload - 署名対象の文字列（任意のプレーンテキスト）
 * @param secret  - HMAC-SHA256 署名シークレット（環境変数 COOKIE_SECRET）
 * @returns `<base64url(payload)>.<base64url(signature)>` 形式の文字列
 */
export async function signCookie(payload: string, secret: string): Promise<string> {
  const key = await importHmacKey(secret);
  const payloadEncoded = toBase64Url(new TextEncoder().encode(payload));
  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payloadEncoded),
  );
  const signatureEncoded = toBase64Url(new Uint8Array(signatureBuffer));
  return `${payloadEncoded}.${signatureEncoded}`;
}

/**
 * 署名付きCookie値を検証し、検証成功時に元のpayloadを返す。
 *
 * @param signedValue - `signCookie` が返した `<base64url(payload)>.<base64url(signature)>` 形式の文字列
 * @param secret      - HMAC-SHA256 署名シークレット（環境変数 COOKIE_SECRET）
 * @returns 検証成功時は元のpayload文字列、失敗時は `null`
 */
export async function verifyCookie(signedValue: string, secret: string): Promise<string | null> {
  const dotIndex = signedValue.lastIndexOf(".");
  if (dotIndex === -1) return null;

  const payloadEncoded = signedValue.slice(0, dotIndex);
  const signatureEncoded = signedValue.slice(dotIndex + 1);

  if (!signatureEncoded) return null;

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = fromBase64Url(signatureEncoded);
  } catch {
    return null;
  }

  const key = await importHmacKey(secret);
  const isValid = await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes,
    new TextEncoder().encode(payloadEncoded),
  );

  if (!isValid) return null;

  try {
    return new TextDecoder().decode(fromBase64Url(payloadEncoded));
  } catch {
    return null;
  }
}

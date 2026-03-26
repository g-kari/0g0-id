/**
 * base64url 文字列をデコードして文字列として返す。
 * JWT やセッションCookieのデコードに共通で使用するユーティリティ。
 *
 * @param input - base64url エンコードされた文字列
 * @returns デコードされた文字列
 */
export function decodeBase64Url(input: string): string {
  const padded = input + '='.repeat((4 - (input.length % 4)) % 4);
  return atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
}

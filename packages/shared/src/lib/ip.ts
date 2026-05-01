/**
 * Cloudflare Workers 環境でクライアントIPを取得する。
 * cf-connecting-ip ヘッダーから取得。未設定時は null を返す。
 */
export function getClientIp(req: Request): string | null {
  return req.headers.get("cf-connecting-ip") ?? null;
}

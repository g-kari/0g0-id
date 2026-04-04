/**
 * リクエスト元 IP アドレスを取得する。
 * Cloudflare 環境では cf-connecting-ip を使用する（偽装不可）。
 * cf-connecting-ip が未設定の場合（ローカル開発・Cloudflare設定ミス）は null を返す。
 * x-forwarded-for はクライアントによる偽装が可能なため使用しない。
 */
export function getClientIp(req: Request): string | null {
  return req.headers.get('cf-connecting-ip') ?? null;
}

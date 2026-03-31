/**
 * リクエスト元 IP アドレスを取得する。
 * Cloudflare 環境では cf-connecting-ip が優先される。
 * x-forwarded-for が複数値の場合は最初の値（クライアントIP）のみを使用する。
 * 取得できない場合は null を返す。
 */
export function getClientIp(req: Request): string | null {
  return (
    req.headers.get('cf-connecting-ip') ??
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    null
  );
}

import type { Context } from "hono";
import type { IdpEnv, TokenPayload } from "@0g0-id/shared";
import { signCookie } from "@0g0-id/shared";

type Variables = { user: TokenPayload };

/**
 * POST /auth/link-intent — SNSプロバイダー連携用ワンタイムトークン発行（認証済みユーザー専用）
 * link_user_id をURLパラメータとして直接受け付けると第三者が任意ユーザーのIDを指定し
 * アカウント乗っ取りが可能なため、アクセストークンで認証したうえでワンタイムトークンを発行する
 */
export async function handleLinkIntent(c: Context<{ Bindings: IdpEnv; Variables: Variables }>) {
  const tokenUser = c.get("user");

  // HMAC-SHA256署名付きトークンを生成（DBアクセス不要、自己完結型）
  // JTI（一意識別子）を付与してワンタイム性を向上。有効期限は2分に短縮して再利用ウィンドウを縮小。
  const tokenPayload = JSON.stringify({
    purpose: "link",
    sub: tokenUser.sub,
    jti: crypto.randomUUID(),
    exp: Date.now() + 2 * 60 * 1000, // 2分
  });
  const linkToken = await signCookie(tokenPayload, c.env.COOKIE_SECRET);

  return c.json({ data: { link_token: linkToken } });
}

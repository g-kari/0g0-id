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
  // JTI を含むが消費チェックは未実装のため、有効期限（2分）内は再利用可能。
  // 厳密なワンタイム性が必要になった場合は KV/DB での消費記録を追加すること。
  const tokenPayload = JSON.stringify({
    purpose: "link",
    sub: tokenUser.sub,
    jti: crypto.randomUUID(),
    exp: Date.now() + 2 * 60 * 1000, // 2分
  });
  const linkToken = await signCookie(tokenPayload, c.env.COOKIE_SECRET);

  return c.json({ data: { link_token: linkToken } });
}

import type { Context } from "hono";
import type { IdpEnv, TokenPayload } from "@0g0-id/shared";
import { signCookie, isSocialLoginProvider, isValidProvider, restErrorBody } from "@0g0-id/shared";

type Variables = { user: TokenPayload };

/**
 * POST /auth/link-intent — SNSプロバイダー連携用ワンタイムトークン発行（認証済みユーザー専用）
 * link_user_id をURLパラメータとして直接受け付けると第三者が任意ユーザーのIDを指定し
 * アカウント乗っ取りが可能なため、アクセストークンで認証したうえでワンタイムトークンを発行する
 */
export async function handleLinkIntent(c: Context<{ Bindings: IdpEnv; Variables: Variables }>) {
  const tokenUser = c.get("user");
  // New providers require explicit, signed intent for this exact method.
  let provider: "discord" | "steam" | undefined;
  if (c.req.header("Content-Type")?.includes("application/json")) {
    const body: unknown = await c.req.json().catch(() => null);
    if (
      !body ||
      typeof body !== "object" ||
      !("provider" in body) ||
      typeof body.provider !== "string" ||
      !isValidProvider(body.provider) ||
      !isSocialLoginProvider(body.provider)
    ) {
      return c.json(restErrorBody("BAD_REQUEST", "Invalid link provider"), 400);
    }
    provider = body.provider;
  }

  // HMAC-SHA256署名付きトークンを生成（DBアクセス不要、自己完結型）
  // JTI を含み、login.ts で KV（LINK_TOKEN_KV）による消費チェックを行うことでワンタイム性を保証する。
  const tokenPayload = JSON.stringify({
    purpose: "link",
    ...(provider ? { provider } : {}),
    sub: tokenUser.sub,
    jti: crypto.randomUUID(),
    exp: Date.now() + 2 * 60 * 1000, // 2分
  });
  const linkToken = await signCookie(tokenPayload, c.env.COOKIE_SECRET);

  return c.json({ data: { link_token: linkToken } });
}

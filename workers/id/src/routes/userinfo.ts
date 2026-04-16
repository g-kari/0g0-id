import { Hono, type Context } from "hono";
import type { IdpEnv, TokenPayload } from "@0g0-id/shared";
import { findUserById, generatePairwiseSub, oauthErrorBody } from "@0g0-id/shared";
import { authMiddleware } from "../middleware/auth";
import { externalApiRateLimitMiddleware } from "../middleware/rate-limit";

type Variables = { user: TokenPayload };
type AppContext = Context<{ Bindings: IdpEnv; Variables: Variables }>;

const app = new Hono<{ Bindings: IdpEnv; Variables: Variables }>();

/**
 * OIDC UserInfo エンドポイント共通ハンドラー。
 * OpenID Connect Core 1.0 Section 5.3 準拠。
 * アクセストークンで認証されたユーザーのクレームを返す。
 */
async function handleUserInfo(c: AppContext): Promise<Response> {
  const tokenUser = c.get("user");

  let user;
  try {
    user = await findUserById(c.env.DB, tokenUser.sub);
  } catch {
    return c.json(oauthErrorBody("server_error", "Internal server error"), 500);
  }
  if (!user) {
    return c.json(oauthErrorBody("invalid_token", "User not found"), 401);
  }

  // BAN済みユーザーのクレーム返却を防止
  if (user.banned_at !== null) {
    return c.json(oauthErrorBody("invalid_token", "Account suspended"), 401);
  }

  // スコープベースのクレームフィルタリング（OIDC Core 1.0 Section 5.3）
  // scope未定義 = BFFセッション（全クレームを返す）
  // scope定義済み = サービストークン（スコープに応じてフィルタリング）
  const scopes = tokenUser.scope ? new Set(tokenUser.scope.split(" ")) : null;

  // サービストークン（cid設定済み）はペアワイズsub、BFFセッションは内部IDを返す
  const sub = tokenUser.cid ? await generatePairwiseSub(tokenUser.cid, user.id) : user.id;

  const claims: Record<string, unknown> = {
    sub,
    updated_at: Math.floor(new Date(user.updated_at).getTime() / 1000),
  };

  if (scopes === null || scopes.has("profile")) {
    claims.name = user.name;
    claims.picture = user.picture;
  }

  if (scopes === null || scopes.has("email")) {
    claims.email = user.email;
    claims.email_verified = user.email_verified === 1;
  }

  if (scopes !== null && scopes.has("phone") && user.phone !== null) {
    claims.phone_number = user.phone;
  }

  if (scopes !== null && scopes.has("address") && user.address !== null) {
    claims.address = { formatted: user.address };
  }

  return c.json(claims);
}

// GET /api/userinfo — OIDC UserInfo エンドポイント (OpenID Connect Core 1.0 Section 5.3)
app.get("/", externalApiRateLimitMiddleware, authMiddleware, handleUserInfo);

// POST /api/userinfo — OIDC Core 1.0 はGET/POSTの両方に対応することを要求
app.post("/", externalApiRateLimitMiddleware, authMiddleware, handleUserInfo);

export default app;

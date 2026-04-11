import { createMiddleware } from "hono/factory";
import {
  verifyAccessToken,
  findUserById,
  isAccessTokenRevoked,
  createLogger,
} from "@0g0-id/shared";
import type { IdpEnv, TokenPayload, User } from "@0g0-id/shared";

const authMiddlewareLogger = createLogger("auth-middleware");

type AuthVariables = {
  user: TokenPayload;
  /** rejectBannedUserMiddleware がDBから取得したユーザー（ルートハンドラーで再利用可能） */
  dbUser: User;
};

/**
 * サービストークン（cid付き）を拒否するミドルウェア。
 * /api/users/me 系のBFFセッション専用エンドポイントで使用する。
 * サービストークンは /userinfo のみ許可されるべきで、内部ユーザー管理APIへのアクセスは禁止。
 */
export const rejectServiceTokenMiddleware = createMiddleware<{
  Bindings: IdpEnv;
  Variables: AuthVariables;
}>(async (c, next) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: { code: "UNAUTHORIZED", message: "Not authenticated" } }, 401);
  }
  if (user.cid) {
    return c.json(
      { error: { code: "FORBIDDEN", message: "Service tokens cannot access this endpoint" } },
      403,
    );
  }
  await next();
});

export const authMiddleware = createMiddleware<{
  Bindings: IdpEnv;
  Variables: AuthVariables;
}>(async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Missing or invalid Authorization header" } },
      401,
    );
  }

  const token = authHeader.slice(7);
  try {
    const payload = await verifyAccessToken(
      token,
      c.env.JWT_PUBLIC_KEY,
      c.env.IDP_ORIGIN,
      c.env.IDP_ORIGIN,
    );
    if (payload.jti && (await isAccessTokenRevoked(c.env.DB, payload.jti))) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Token has been revoked" } }, 401);
    }
    c.set("user", payload);
    await next();
  } catch {
    return c.json({ error: { code: "UNAUTHORIZED", message: "Invalid or expired token" } }, 401);
  }
});

/**
 * BAN済みユーザーを拒否するミドルウェア。
 * authMiddleware の後に配置して使用する。
 * アクセストークン有効期限内でもBAN済みユーザーを即時ブロックする。
 */
export const rejectBannedUserMiddleware = createMiddleware<{
  Bindings: IdpEnv;
  Variables: AuthVariables;
}>(async (c, next) => {
  const tokenUser = c.get("user");
  if (!tokenUser) {
    return c.json({ error: { code: "UNAUTHORIZED", message: "Not authenticated" } }, 401);
  }
  let user;
  try {
    user = await findUserById(c.env.DB, tokenUser.sub);
  } catch {
    return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
  }
  if (!user) {
    authMiddlewareLogger.warn("rejectBannedUser: user not found in DB", { sub: tokenUser.sub });
    // ユーザー列挙を防ぐため、クライアントには banned と同一レスポンスを返す
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Account suspended or not found" } },
      401,
    );
  }
  if (user.banned_at !== null) {
    authMiddlewareLogger.warn("rejectBannedUser: banned user attempted access", {
      sub: tokenUser.sub,
      bannedAt: user.banned_at,
    });
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Account suspended or not found" } },
      401,
    );
  }
  c.set("dbUser", user);
  await next();
});

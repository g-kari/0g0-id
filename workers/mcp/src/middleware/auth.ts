import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { TokenPayload } from "@0g0-id/shared";
import { findUserById, isAccessTokenRevoked } from "@0g0-id/shared";

type McpEnv = {
  Bindings: {
    DB: D1Database;
    IDP: Fetcher;
    IDP_ORIGIN: string;
    MCP_ORIGIN: string;
  };
  Variables: {
    user: TokenPayload;
  };
};

const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;

interface JwksCacheEntry {
  jwks: ReturnType<typeof createRemoteJWKSet>;
  cachedAt: number;
}

const jwksCache = new Map<string, JwksCacheEntry>();

/** @internal テスト用 */
export function resetJwksCache(): void {
  jwksCache.clear();
}

function getJWKS(idpOrigin: string): ReturnType<typeof createRemoteJWKSet> {
  const entry = jwksCache.get(idpOrigin);
  if (entry && Date.now() - entry.cachedAt < JWKS_CACHE_TTL_MS) return entry.jwks;
  const jwks = createRemoteJWKSet(new URL(`${idpOrigin}/.well-known/jwks.json`));
  jwksCache.set(idpOrigin, { jwks, cachedAt: Date.now() });
  return jwks;
}

/**
 * MCP OAuth Bearer Token 認証ミドルウェア
 * Authorization: Bearer <token> ヘッダーからJWTを検証する。
 * IDP の JWKS エンドポイントから公開鍵を取得し ES256 署名を検証する。
 */
export const mcpAuthMiddleware = createMiddleware<McpEnv>(
  async (c, next): Promise<Response | void> => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      c.header(
        "WWW-Authenticate",
        `Bearer resource_metadata="${c.env.MCP_ORIGIN}/.well-known/oauth-protected-resource"`,
      );
      return c.json({ error: { code: "UNAUTHORIZED", message: "Bearer token required" } }, 401);
    }

    const token = authHeader.slice(7);

    try {
      const jwks = getJWKS(c.env.IDP_ORIGIN);
      const { payload } = await jwtVerify(token, jwks, {
        issuer: c.env.IDP_ORIGIN,
        audience: c.env.IDP_ORIGIN,
        algorithms: ["ES256"],
      });
      const user = payload as unknown as TokenPayload;

      // リボークされたトークンを拒否（JWT有効期限内でも即時無効化）
      if (user.jti && (await isAccessTokenRevoked(c.env.DB, user.jti))) {
        c.header(
          "WWW-Authenticate",
          `Bearer error="invalid_token", resource_metadata="${c.env.MCP_ORIGIN}/.well-known/oauth-protected-resource"`,
        );
        return c.json({ error: { code: "UNAUTHORIZED", message: "Token has been revoked" } }, 401);
      }

      c.set("user", user);
      await next();
    } catch {
      c.header(
        "WWW-Authenticate",
        `Bearer error="invalid_token", resource_metadata="${c.env.MCP_ORIGIN}/.well-known/oauth-protected-resource"`,
      );
      return c.json({ error: { code: "UNAUTHORIZED", message: "Invalid or expired token" } }, 401);
    }
  },
);

/**
 * BAN済みユーザー拒否ミドルウェア。
 * mcpAuthMiddleware の後に配置して使用する。
 * DBからユーザーを取得し、BANされている場合は401を返す。
 */
export const mcpRejectBannedUserMiddleware = createMiddleware<McpEnv>(
  async (c, next): Promise<Response | void> => {
    const user = c.get("user");
    if (!user) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Not authenticated" } }, 401);
    }
    let dbUser;
    try {
      dbUser = await findUserById(c.env.DB, user.sub);
    } catch {
      return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
    }
    if (!dbUser || dbUser.banned_at !== null) {
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Account suspended or not found" } },
        401,
      );
    }
    await next();
  },
);

/**
 * 管理者ロール必須ミドルウェア。
 * mcpAuthMiddleware の後に配置して使用する。
 */
export const mcpAdminMiddleware = createMiddleware<McpEnv>(
  async (c, next): Promise<Response | void> => {
    const user = c.get("user");
    if (!user || user.role !== "admin") {
      return c.json({ error: { code: "FORBIDDEN", message: "Admin role required" } }, 403);
    }

    // jtiが存在しないトークンは管理者エンドポイントでは拒否（リボークチェック必須）
    if (!user.jti) {
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Invalid token: missing jti" } },
        401,
      );
    }

    // リボークされたトークンを拒否（JWT有効期限内でも即時無効化）
    if (await isAccessTokenRevoked(c.env.DB, user.jti)) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Token has been revoked" } }, 401);
    }

    await next();
  },
);

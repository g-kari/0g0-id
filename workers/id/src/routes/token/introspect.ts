import type { Context } from "hono";
import type { IdpEnv, User, Service, RefreshToken, TokenPayload } from "@0g0-id/shared";
import {
  findRefreshTokenByHash,
  findUserById,
  sha256,
  generatePairwiseSub,
  verifyAccessToken,
  isAccessTokenRevoked,
  createLogger,
} from "@0g0-id/shared";
import { authenticateService } from "../../utils/service-auth";
import { parseTokenBody, applyUserClaims } from "./utils";

const tokenLogger = createLogger("token");

/**
 * イントロスペクション: リフレッシュトークンの検証ヘルパー（RFC 7662）
 */
async function introspectRefreshToken(
  db: D1Database,
  service: Service,
  tokenHash: string,
  issuer: string,
): Promise<Record<string, unknown> | null> {
  let refreshToken: RefreshToken | null;
  let user: User | null | undefined;
  try {
    refreshToken = await findRefreshTokenByHash(db, tokenHash);
    if (!refreshToken) return null;
    if (refreshToken.revoked_at !== null) return { active: false };
    if (refreshToken.service_id !== service.id) {
      tokenLogger.warn(`[introspect] service_id mismatch for requesting service.id=${service.id}`);
      return { active: false };
    }
    if (new Date(refreshToken.expires_at) < new Date()) {
      return { active: false };
    }
    user = await findUserById(db, refreshToken.user_id);
  } catch (err) {
    tokenLogger.error("Introspect: DB error in introspectRefreshToken", err);
    throw err;
  }
  if (!user || user.banned_at !== null) {
    return { active: false };
  }
  const scopeStr = refreshToken.scope ?? "";
  const scopeList = scopeStr.split(" ").filter((s: string) => s !== "openid" && s !== "");
  const sub = await generatePairwiseSub(service.client_id, refreshToken.user_id);
  const response: Record<string, unknown> = {
    active: true,
    iss: issuer,
    token_type: "refresh_token",
    sub,
    exp: Math.floor(new Date(refreshToken.expires_at).getTime() / 1000),
    iat: Math.floor(new Date(refreshToken.created_at).getTime() / 1000),
    scope: scopeStr,
  };
  applyUserClaims(response, user, scopeList);
  return response;
}

/**
 * イントロスペクション: JWTアクセストークンの検証ヘルパー（RFC 7662）
 */
async function introspectJwtToken(
  db: D1Database,
  service: Service,
  token: string,
  env: IdpEnv,
): Promise<Record<string, unknown> | null> {
  let payload: TokenPayload;
  try {
    payload = await verifyAccessToken(token, env.JWT_PUBLIC_KEY, env.IDP_ORIGIN, env.IDP_ORIGIN);
  } catch (err) {
    tokenLogger.warn("Introspect: JWT verification failed", err);
    return null;
  }
  try {
    if (payload.jti && (await isAccessTokenRevoked(db, payload.jti))) {
      return { active: false };
    }
    if (!payload.cid || payload.cid !== service.client_id) {
      return { active: false };
    }
    const tokenUser = await findUserById(db, payload.sub);
    if (!tokenUser || tokenUser.banned_at !== null) {
      return { active: false };
    }
    const tokenScopeStr = payload.scope ?? "";
    const tokenScopes = tokenScopeStr.split(" ").filter((s: string) => s !== "openid" && s !== "");
    const sub = await generatePairwiseSub(service.client_id, payload.sub);
    const jwtResponse: Record<string, unknown> = {
      active: true,
      iss: payload.iss,
      sub,
      exp: payload.exp,
      iat: payload.iat,
      scope: tokenScopeStr,
      token_type: "access_token",
    };
    applyUserClaims(jwtResponse, tokenUser, tokenScopes);
    return jwtResponse;
  } catch (err) {
    tokenLogger.error("Introspect: DB error in introspectJwtToken", err);
    throw err;
  }
}

/**
 * POST /api/token/introspect — RFC 7662 トークンイントロスペクション
 */
export async function handleIntrospect(c: Context<{ Bindings: IdpEnv }>) {
  // Basic認証でサービス認証
  let service: Service | null;
  try {
    service = await authenticateService(c.env.DB, c.req.header("Authorization"));
  } catch (err) {
    tokenLogger.error("Introspect: service authentication failed", err);
    return c.json({ error: "server_error" }, 500);
  }
  if (!service) {
    c.header("WWW-Authenticate", 'Basic realm="0g0-id"');
    return c.json({ active: false }, 401);
  }
  const introspectService = service;

  // トークン取得（RFC 7662: application/x-www-form-urlencoded および application/json に対応）
  const body = await parseTokenBody(c.req);
  if (!body) {
    return c.json({ active: false }, 400);
  }
  if (!body.token) {
    return c.json({ active: false }, 400);
  }

  const token = body.token;
  const tokenHash = await sha256(token);

  // token_type_hint に従って検索順を最適化（RFC 7662 §2.1 推奨）
  let result: Record<string, unknown> | null;
  try {
    if (body.token_type_hint === "access_token") {
      result = await introspectJwtToken(c.env.DB, introspectService, token, c.env);
      if (result === null) {
        result = await introspectRefreshToken(
          c.env.DB,
          introspectService,
          tokenHash,
          c.env.IDP_ORIGIN,
        );
      }
    } else {
      result = await introspectRefreshToken(
        c.env.DB,
        introspectService,
        tokenHash,
        c.env.IDP_ORIGIN,
      );
      if (result === null) {
        result = await introspectJwtToken(c.env.DB, introspectService, token, c.env);
      }
    }
  } catch (err) {
    tokenLogger.error("Introspect: unexpected server error", err);
    return c.json({ error: "server_error" }, 500);
  }

  return c.json(result ?? { active: false });
}

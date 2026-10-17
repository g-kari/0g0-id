import { Hono } from "hono";
import type { IdpEnv, User } from "@0g0-id/shared";
import {
  listUserConnections,
  revokeUserServiceTokens,
  revokeUserTokens,
  deleteMcpSessionsByUser,
  revokeAllBffSessionsByUserId,
  revokeBffSessionByIdForUser,
  revokeTokenByIdForUser,
  revokeOtherUserTokens,
  listActiveSessionsByUserId,
  listActiveBffSessionsByUserId,
  getUserProviders,
  unlinkProvider,
  getLoginEventsByUserId,
  getUserLoginProviderStats,
  getUserDailyLoginTrends,
  updateUserProfile,
  parseDays,
  paginationMiddleware,
  isValidProvider,
  UUID_RE,
  parseJsonBody,
  type OAuthProvider,
} from "@0g0-id/shared";
import {
  authMiddleware,
  rejectServiceTokenMiddleware,
  rejectBannedUserMiddleware,
} from "../../middleware/auth";
import { csrfMiddleware } from "../../middleware/csrf";
import type { Variables } from "./_shared";
import {
  PatchMeSchema,
  RevokeOthersSchema,
  formatMyProfile,
  performUserDeletion,
  usersLogger,
} from "./_shared";

const app = new Hono<{ Bindings: IdpEnv; Variables: Variables }>();

// GET /api/users/me
app.get(
  "/me",
  authMiddleware,
  rejectServiceTokenMiddleware,
  rejectBannedUserMiddleware,
  async (c) => {
    const user = c.get("dbUser");
    return c.json({ data: formatMyProfile(user) });
  },
);

// GET /api/users/me/data-export — GDPR準拠のアカウントデータ一括エクスポート
app.get(
  "/me/data-export",
  authMiddleware,
  rejectServiceTokenMiddleware,
  rejectBannedUserMiddleware,
  async (c) => {
    const user = c.get("dbUser");
    const userId = user.id;

    let providers, connections, loginHistory, sessions;
    try {
      [providers, connections, { events: loginHistory }, sessions] = await Promise.all([
        getUserProviders(c.env.DB, userId),
        listUserConnections(c.env.DB, userId),
        getLoginEventsByUserId(c.env.DB, userId, 1000, 0),
        listActiveSessionsByUserId(c.env.DB, userId),
      ]);
    } catch (err) {
      usersLogger.error("[data-export] Failed to fetch user data", err);
      return c.json(
        { error: { code: "INTERNAL_ERROR", message: "Failed to fetch user data" } },
        500,
      );
    }

    return c.json({
      data: {
        exported_at: new Date().toISOString(),
        profile: {
          id: user.id,
          email: user.email,
          email_verified: user.email_verified === 1,
          name: user.name,
          picture: user.picture,
          phone: user.phone,
          address: user.address,
          role: user.role,
          created_at: user.created_at,
          updated_at: user.updated_at,
        },
        providers,
        service_connections: connections,
        login_history: loginHistory,
        active_sessions: sessions,
      },
    });
  },
);

// PATCH /api/users/me
app.patch(
  "/me",
  authMiddleware,
  rejectServiceTokenMiddleware,
  rejectBannedUserMiddleware,
  csrfMiddleware,
  async (c) => {
    const tokenUser = c.get("user");

    const result = await parseJsonBody(c, PatchMeSchema);
    if (!result.ok) return result.response;
    const body = result.data;

    const profileUpdate: {
      name?: string;
      picture?: string | null;
      phone?: string | null;
      address?: string | null;
    } = {};
    if (body.name !== undefined) profileUpdate.name = body.name.trim();
    if ("picture" in body)
      profileUpdate.picture = body.picture ? body.picture.trim() || null : null;
    if ("phone" in body) profileUpdate.phone = body.phone ? body.phone.trim() || null : null;
    if ("address" in body)
      profileUpdate.address = body.address ? body.address.trim() || null : null;

    let user: User;
    try {
      user = await updateUserProfile(c.env.DB, tokenUser.sub, profileUpdate);
    } catch (err) {
      if (err instanceof Error && err.message === "User not found") {
        return c.json({ error: { code: "NOT_FOUND", message: "User not found" } }, 404);
      }
      throw err;
    }

    return c.json({ data: formatMyProfile(user) });
  },
);

// GET /api/users/me/connections
app.get(
  "/me/connections",
  authMiddleware,
  rejectServiceTokenMiddleware,
  rejectBannedUserMiddleware,
  async (c) => {
    const tokenUser = c.get("user");
    const connections = await listUserConnections(c.env.DB, tokenUser.sub);
    return c.json({ data: connections });
  },
);

// GET /api/users/me/providers — 連携済みSNSプロバイダー一覧
app.get(
  "/me/providers",
  authMiddleware,
  rejectServiceTokenMiddleware,
  rejectBannedUserMiddleware,
  async (c) => {
    const tokenUser = c.get("user");
    const providers = await getUserProviders(c.env.DB, tokenUser.sub);
    return c.json({ data: providers });
  },
);

// GET /api/users/me/login-history — 自分のログイン履歴取得
app.get(
  "/me/login-history",
  authMiddleware,
  rejectServiceTokenMiddleware,
  rejectBannedUserMiddleware,
  paginationMiddleware({ defaultLimit: 20, maxLimit: 100 }),
  async (c) => {
    const tokenUser = c.get("user");
    const { limit, offset } = c.get("pagination");
    const providerParam = c.req.query("provider") || undefined;
    if (providerParam !== undefined && !isValidProvider(providerParam)) {
      return c.json({ error: { code: "BAD_REQUEST", message: "Invalid provider" } }, 400);
    }

    const { events, total } = await getLoginEventsByUserId(
      c.env.DB,
      tokenUser.sub,
      limit,
      offset,
      providerParam,
    );
    return c.json({ data: events, total });
  },
);

// GET /api/users/me/login-stats — 自分のプロバイダー別ログイン統計
app.get(
  "/me/login-stats",
  authMiddleware,
  rejectServiceTokenMiddleware,
  rejectBannedUserMiddleware,
  async (c) => {
    const tokenUser = c.get("user");
    const daysResult = parseDays(c.req.query("days"), { maxDays: 365 });
    if (daysResult && "error" in daysResult) {
      return c.json({ error: { code: "BAD_REQUEST", message: daysResult.error } }, 400);
    }
    const days = daysResult?.days ?? 30;
    const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const stats = await getUserLoginProviderStats(c.env.DB, tokenUser.sub, sinceIso);
    return c.json({ data: stats, days });
  },
);

// GET /api/users/me/login-trends — 自分の日別ログイントレンド
app.get(
  "/me/login-trends",
  authMiddleware,
  rejectServiceTokenMiddleware,
  rejectBannedUserMiddleware,
  async (c) => {
    const tokenUser = c.get("user");
    const daysResult = parseDays(c.req.query("days"), { maxDays: 365 });
    if (daysResult && "error" in daysResult) {
      return c.json({ error: { code: "BAD_REQUEST", message: daysResult.error } }, 400);
    }
    const days = daysResult?.days ?? 30;
    const trends = await getUserDailyLoginTrends(c.env.DB, tokenUser.sub, days);
    return c.json({ data: trends, days });
  },
);

// GET /api/users/me/security-summary — セキュリティ概要
app.get(
  "/me/security-summary",
  authMiddleware,
  rejectServiceTokenMiddleware,
  rejectBannedUserMiddleware,
  async (c) => {
    const user = c.get("dbUser");
    const userId = user.id;

    let sessions, connections, loginHistory, providers;
    try {
      [sessions, connections, loginHistory, providers] = await Promise.all([
        listActiveSessionsByUserId(c.env.DB, userId),
        listUserConnections(c.env.DB, userId),
        getLoginEventsByUserId(c.env.DB, userId, 1, 0),
        getUserProviders(c.env.DB, userId),
      ]);
    } catch (err) {
      usersLogger.error("[security-summary] Failed to fetch user data", err);
      return c.json(
        { error: { code: "INTERNAL_ERROR", message: "Failed to fetch security data" } },
        500,
      );
    }

    const linkedProviders = providers.filter((p) => p.connected).map((p) => p.provider);
    const lastLoginEvent = loginHistory.events[0] ?? null;

    return c.json({
      data: {
        active_sessions_count: sessions.length,
        connected_services_count: connections.length,
        linked_providers: linkedProviders,
        last_login: lastLoginEvent
          ? {
              provider: lastLoginEvent.provider,
              ip_address: lastLoginEvent.ip_address,
              created_at: lastLoginEvent.created_at,
            }
          : null,
        account_created_at: user.created_at,
      },
    });
  },
);

// DELETE /api/users/me/providers/:provider — SNSプロバイダー連携解除
app.delete(
  "/me/providers/:provider",
  authMiddleware,
  rejectServiceTokenMiddleware,
  rejectBannedUserMiddleware,
  csrfMiddleware,
  async (c) => {
    const tokenUser = c.get("user");
    const providerParam = c.req.param("provider");
    if (!isValidProvider(providerParam)) {
      return c.json({ error: { code: "BAD_REQUEST", message: "Invalid provider" } }, 400);
    }
    const provider: OAuthProvider = providerParam;

    const providers = await getUserProviders(c.env.DB, tokenUser.sub);
    const targetProvider = providers.find((p) => p.provider === provider);
    if (!targetProvider?.connected) {
      return c.json({ error: { code: "NOT_FOUND", message: "Provider not connected" } }, 404);
    }
    const connectedCount = providers.filter((p) => p.connected).length;
    if (connectedCount <= 1) {
      return c.json(
        { error: { code: "LAST_PROVIDER", message: "Cannot unlink the last provider" } },
        409,
      );
    }

    await unlinkProvider(c.env.DB, tokenUser.sub, provider);

    return c.body(null, 204);
  },
);

// DELETE /api/users/me/connections/:serviceId
app.delete(
  "/me/connections/:serviceId",
  authMiddleware,
  rejectServiceTokenMiddleware,
  rejectBannedUserMiddleware,
  csrfMiddleware,
  async (c) => {
    const tokenUser = c.get("user");
    const serviceId = c.req.param("serviceId");
    if (!UUID_RE.test(serviceId)) {
      return c.json({ error: { code: "BAD_REQUEST", message: "Invalid service ID format" } }, 400);
    }
    const revoked = await revokeUserServiceTokens(
      c.env.DB,
      tokenUser.sub,
      serviceId,
      "user_logout",
    );
    if (revoked === 0) {
      return c.json({ error: { code: "NOT_FOUND", message: "Connection not found" } }, 404);
    }
    return c.body(null, 204);
  },
);

// GET /api/users/me/tokens — アクティブセッション一覧
app.get(
  "/me/tokens",
  authMiddleware,
  rejectServiceTokenMiddleware,
  rejectBannedUserMiddleware,
  async (c) => {
    const tokenUser = c.get("user");
    const sessions = await listActiveSessionsByUserId(c.env.DB, tokenUser.sub);
    return c.json({ data: sessions });
  },
);

// GET /api/users/me/bff-sessions — 自分のBFFセッション一覧
app.get(
  "/me/bff-sessions",
  authMiddleware,
  rejectServiceTokenMiddleware,
  rejectBannedUserMiddleware,
  async (c) => {
    const tokenUser = c.get("user");
    const sessions = await listActiveBffSessionsByUserId(c.env.DB, tokenUser.sub);
    return c.json({ data: sessions });
  },
);

// DELETE /api/users/me/tokens/others — 現在のセッション以外を全て失効
app.delete(
  "/me/tokens/others",
  authMiddleware,
  rejectServiceTokenMiddleware,
  rejectBannedUserMiddleware,
  csrfMiddleware,
  async (c) => {
    const tokenUser = c.get("user");
    const result = await parseJsonBody(c, RevokeOthersSchema);
    if (!result.ok) return result.response;
    const { token_hash } = result.data;

    const count = await revokeOtherUserTokens(
      c.env.DB,
      tokenUser.sub,
      token_hash,
      "user_logout_others",
    );
    return c.json({ data: { revoked_count: count } });
  },
);

// DELETE /api/users/me/tokens/:tokenId — 特定セッションのみログアウト
app.delete(
  "/me/tokens/:tokenId",
  authMiddleware,
  rejectServiceTokenMiddleware,
  rejectBannedUserMiddleware,
  csrfMiddleware,
  async (c) => {
    const tokenUser = c.get("user");
    const tokenId = c.req.param("tokenId");
    if (!UUID_RE.test(tokenId)) {
      return c.json({ error: { code: "BAD_REQUEST", message: "Invalid token ID format" } }, 400);
    }
    const revoked = await revokeTokenByIdForUser(c.env.DB, tokenId, tokenUser.sub, "user_logout");
    if (revoked === 0) {
      return c.json({ error: { code: "NOT_FOUND", message: "Session not found" } }, 404);
    }
    return c.body(null, 204);
  },
);

// DELETE /api/users/me/bff-sessions/:sessionId — 自分の特定 BFF セッションを失効
app.delete(
  "/me/bff-sessions/:sessionId",
  authMiddleware,
  rejectServiceTokenMiddleware,
  rejectBannedUserMiddleware,
  csrfMiddleware,
  async (c) => {
    const tokenUser = c.get("user");
    const sessionId = c.req.param("sessionId");
    if (!UUID_RE.test(sessionId)) {
      return c.json({ error: { code: "BAD_REQUEST", message: "Invalid session ID format" } }, 400);
    }
    const revoked = await revokeBffSessionByIdForUser(
      c.env.DB,
      sessionId,
      tokenUser.sub,
      "user_self_revoke",
    );
    if (revoked === 0) {
      return c.json({ error: { code: "NOT_FOUND", message: "BFF session not found" } }, 404);
    }
    return c.body(null, 204);
  },
);

// DELETE /api/users/me/tokens — 全デバイスからログアウト
app.delete(
  "/me/tokens",
  authMiddleware,
  rejectServiceTokenMiddleware,
  rejectBannedUserMiddleware,
  csrfMiddleware,
  async (c) => {
    const tokenUser = c.get("user");
    await revokeUserTokens(c.env.DB, tokenUser.sub, "user_logout_all");
    await deleteMcpSessionsByUser(c.env.DB, tokenUser.sub);
    await revokeAllBffSessionsByUserId(c.env.DB, tokenUser.sub, "user_logout_all");
    return c.body(null, 204);
  },
);

// DELETE /api/users/me — 自分のアカウントを削除
app.delete(
  "/me",
  authMiddleware,
  rejectServiceTokenMiddleware,
  rejectBannedUserMiddleware,
  csrfMiddleware,
  async (c) => {
    const user = c.get("dbUser");

    const deleteError = await performUserDeletion(c.env.DB, user.id);
    if (deleteError) {
      return c.json({ error: deleteError }, 409);
    }

    return c.body(null, 204);
  },
);

export default app;

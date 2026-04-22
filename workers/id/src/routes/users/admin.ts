import { Hono } from "hono";
import type { IdpEnv, UserFilter } from "@0g0-id/shared";
import {
  findUserById,
  listUsers,
  countUsers,
  listUserConnections,
  revokeUserTokens,
  deleteMcpSessionsByUser,
  revokeBffSessionByIdForUser,
  revokeTokenByIdForUser,
  listActiveSessionsByUserId,
  listActiveBffSessionsByUserId,
  listServicesByOwner,
  getUserProviders,
  getLoginEventsByUserId,
  getUserLoginProviderStats,
  getUserDailyLoginTrends,
  updateUserRoleWithRevocation,
  banUserWithRevocation,
  unbanUser,
  parseDays,
  requirePagination,
  isValidProvider,
  UUID_RE,
  parseJsonBody,
  getAccountLockout,
  clearLockout,
} from "@0g0-id/shared";
import { authMiddleware } from "../../middleware/auth";
import { adminMiddleware } from "../../middleware/admin";
import { csrfMiddleware } from "../../middleware/csrf";
import { logAdminAudit, extractErrorMessage } from "../../lib/audit";
import type { Variables } from "./_shared";
import {
  PatchRoleSchema,
  formatAdminUserDetail,
  formatAdminUserSummary,
  performUserDeletion,
  usersLogger,
} from "./_shared";

const app = new Hono<{ Bindings: IdpEnv; Variables: Variables }>();

// GET /api/users/:id（管理者のみ）
app.get("/:id", authMiddleware, adminMiddleware, async (c) => {
  const targetId = c.req.param("id");
  const user = await findUserById(c.env.DB, targetId);
  if (!user) {
    return c.json({ error: { code: "NOT_FOUND", message: "User not found" } }, 404);
  }
  return c.json({ data: formatAdminUserDetail(user) });
});

// GET /api/users/:id/owned-services — ユーザーが所有するサービス一覧（管理者のみ）
app.get("/:id/owned-services", authMiddleware, adminMiddleware, async (c) => {
  const targetId = c.req.param("id");

  const targetUser = await findUserById(c.env.DB, targetId);
  if (!targetUser) {
    return c.json({ error: { code: "NOT_FOUND", message: "User not found" } }, 404);
  }

  const services = await listServicesByOwner(c.env.DB, targetId);
  return c.json({
    data: services.map((s) => ({
      id: s.id,
      name: s.name,
      client_id: s.client_id,
      allowed_scopes: s.allowed_scopes,
      created_at: s.created_at,
    })),
  });
});

// GET /api/users/:id/services — ユーザーが認可しているサービス一覧（管理者のみ）
app.get("/:id/services", authMiddleware, adminMiddleware, async (c) => {
  const targetId = c.req.param("id");

  const targetUser = await findUserById(c.env.DB, targetId);
  if (!targetUser) {
    return c.json({ error: { code: "NOT_FOUND", message: "User not found" } }, 404);
  }

  const connections = await listUserConnections(c.env.DB, targetId);
  return c.json({ data: connections });
});

// GET /api/users/:id/providers — ユーザーのSNSプロバイダー連携状態（管理者のみ）
app.get("/:id/providers", authMiddleware, adminMiddleware, async (c) => {
  const targetId = c.req.param("id");

  const targetUser = await findUserById(c.env.DB, targetId);
  if (!targetUser) {
    return c.json({ error: { code: "NOT_FOUND", message: "User not found" } }, 404);
  }

  const providers = await getUserProviders(c.env.DB, targetId);
  return c.json({ data: providers });
});

// GET /api/users/:id/login-history（管理者のみ）
app.get("/:id/login-history", authMiddleware, adminMiddleware, async (c) => {
  const targetId = c.req.param("id");
  const pagination = requirePagination(c, { defaultLimit: 20, maxLimit: 100 });
  if (pagination instanceof Response) return pagination;
  const { limit, offset } = pagination;
  const providerParam = c.req.query("provider") || undefined;
  if (providerParam !== undefined && !isValidProvider(providerParam)) {
    return c.json({ error: { code: "BAD_REQUEST", message: "Invalid provider" } }, 400);
  }

  const targetUser = await findUserById(c.env.DB, targetId);
  if (!targetUser) {
    return c.json({ error: { code: "NOT_FOUND", message: "User not found" } }, 404);
  }

  const { events, total } = await getLoginEventsByUserId(
    c.env.DB,
    targetId,
    limit,
    offset,
    providerParam,
  );
  return c.json({ data: events, total });
});

// GET /api/users/:id/login-stats — ユーザーのプロバイダー別ログイン統計（管理者のみ）
app.get("/:id/login-stats", authMiddleware, adminMiddleware, async (c) => {
  const targetId = c.req.param("id");
  const daysResult = parseDays(c.req.query("days"), { maxDays: 365 });
  if (daysResult && "error" in daysResult) {
    return c.json({ error: { code: "BAD_REQUEST", message: daysResult.error } }, 400);
  }
  const days = daysResult?.days ?? 30;

  const targetUser = await findUserById(c.env.DB, targetId);
  if (!targetUser) {
    return c.json({ error: { code: "NOT_FOUND", message: "User not found" } }, 404);
  }

  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const stats = await getUserLoginProviderStats(c.env.DB, targetId, sinceIso);
  return c.json({ data: stats, days });
});

// GET /api/users/:id/login-trends — ユーザーの日別ログイントレンド（管理者のみ）
app.get("/:id/login-trends", authMiddleware, adminMiddleware, async (c) => {
  const targetId = c.req.param("id");
  const daysResult = parseDays(c.req.query("days"), { maxDays: 365 });
  if (daysResult && "error" in daysResult) {
    return c.json({ error: { code: "BAD_REQUEST", message: daysResult.error } }, 400);
  }
  const days = daysResult?.days ?? 30;

  const targetUser = await findUserById(c.env.DB, targetId);
  if (!targetUser) {
    return c.json({ error: { code: "NOT_FOUND", message: "User not found" } }, 404);
  }

  const trends = await getUserDailyLoginTrends(c.env.DB, targetId, days);
  return c.json({ data: trends, days });
});

// PATCH /api/users/:id/role（管理者のみ）
app.patch("/:id/role", authMiddleware, adminMiddleware, csrfMiddleware, async (c) => {
  const targetId = c.req.param("id");
  const tokenUser = c.get("user");

  const result = await parseJsonBody(c, PatchRoleSchema);
  if (!result.ok) return result.response;
  const { role } = result.data;

  if (targetId === tokenUser.sub) {
    return c.json({ error: { code: "FORBIDDEN", message: "Cannot change your own role" } }, 403);
  }

  const targetUser = await findUserById(c.env.DB, targetId);
  if (!targetUser) {
    return c.json({ error: { code: "NOT_FOUND", message: "User not found" } }, 404);
  }

  if (targetUser.role === role) {
    return c.json({ data: formatAdminUserSummary(targetUser) });
  }

  let user;
  try {
    user = await updateUserRoleWithRevocation(c.env.DB, targetId, role);
  } catch (err) {
    await logAdminAudit(c, {
      action: "user.role_change",
      targetType: "user",
      targetId,
      details: {
        from: targetUser.role,
        to: role,
        error: extractErrorMessage(err),
      },
      status: "failure",
    });
    return c.json(
      { error: { code: "INTERNAL_ERROR", message: "Failed to change user role" } },
      500,
    );
  }

  await logAdminAudit(c, {
    action: "user.role_change",
    targetType: "user",
    targetId,
    details: { from: targetUser.role, to: role },
  });

  return c.json({ data: formatAdminUserSummary(user) });
});

// PATCH /api/users/:id/ban — ユーザーを停止（管理者のみ）
app.patch("/:id/ban", authMiddleware, adminMiddleware, csrfMiddleware, async (c) => {
  const targetId = c.req.param("id");
  const tokenUser = c.get("user");

  if (targetId === tokenUser.sub) {
    return c.json({ error: { code: "FORBIDDEN", message: "Cannot ban yourself" } }, 403);
  }

  const targetUser = await findUserById(c.env.DB, targetId);
  if (!targetUser) {
    return c.json({ error: { code: "NOT_FOUND", message: "User not found" } }, 404);
  }

  if (targetUser.role === "admin") {
    return c.json({ error: { code: "FORBIDDEN", message: "Cannot ban an admin user" } }, 403);
  }

  if (targetUser.banned_at !== null) {
    return c.json({ error: { code: "CONFLICT", message: "User is already banned" } }, 409);
  }

  let updated;
  try {
    updated = await banUserWithRevocation(c.env.DB, targetId);
  } catch (err) {
    await logAdminAudit(c, {
      action: "user.ban",
      targetType: "user",
      targetId,
      details: { error: extractErrorMessage(err) },
      status: "failure",
    });
    return c.json({ error: { code: "INTERNAL_ERROR", message: "Failed to ban user" } }, 500);
  }

  await logAdminAudit(c, {
    action: "user.ban",
    targetType: "user",
    targetId,
  });

  return c.json({ data: formatAdminUserSummary(updated) });
});

// DELETE /api/users/:id/ban — ユーザー停止を解除（管理者のみ）
app.delete("/:id/ban", authMiddleware, adminMiddleware, csrfMiddleware, async (c) => {
  const targetId = c.req.param("id");

  const targetUser = await findUserById(c.env.DB, targetId);
  if (!targetUser) {
    return c.json({ error: { code: "NOT_FOUND", message: "User not found" } }, 404);
  }

  if (targetUser.banned_at === null) {
    return c.json({ error: { code: "CONFLICT", message: "User is not banned" } }, 409);
  }

  let updated;
  try {
    updated = await unbanUser(c.env.DB, targetId);
    await logAdminAudit(c, {
      action: "user.unban",
      targetType: "user",
      targetId,
    });
  } catch (err) {
    await logAdminAudit(c, {
      action: "user.unban",
      targetType: "user",
      targetId,
      details: { error: extractErrorMessage(err) },
      status: "failure",
    });
    throw err;
  }

  return c.json({ data: formatAdminUserSummary(updated) });
});

// GET /api/users/:id/lockout — ユーザーのロックアウト状態（管理者のみ）
app.get("/:id/lockout", authMiddleware, adminMiddleware, async (c) => {
  const targetId = c.req.param("id");

  const targetUser = await findUserById(c.env.DB, targetId);
  if (!targetUser) {
    return c.json({ error: { code: "NOT_FOUND", message: "User not found" } }, 404);
  }

  const lockout = await getAccountLockout(c.env.DB, targetId);
  if (!lockout) {
    return c.json({
      data: { user_id: targetId, failed_attempts: 0, locked_until: null, last_failed_at: null },
    });
  }

  const now = new Date().toISOString();
  const isLocked = lockout.locked_until !== null && lockout.locked_until > now;
  return c.json({
    data: {
      ...lockout,
      is_locked: isLocked,
    },
  });
});

// DELETE /api/users/:id/lockout — ロックアウト解除（管理者のみ）
app.delete("/:id/lockout", authMiddleware, adminMiddleware, csrfMiddleware, async (c) => {
  const targetId = c.req.param("id");

  const targetUser = await findUserById(c.env.DB, targetId);
  if (!targetUser) {
    return c.json({ error: { code: "NOT_FOUND", message: "User not found" } }, 404);
  }

  await clearLockout(c.env.DB, targetId);

  await logAdminAudit(c, {
    action: "user.lockout_clear",
    targetType: "user",
    targetId,
  });

  return c.json({ data: { message: "Lockout cleared" } });
});

// GET /api/users/:id/tokens — ユーザーのアクティブセッション一覧（管理者のみ）
app.get("/:id/tokens", authMiddleware, adminMiddleware, async (c) => {
  const targetId = c.req.param("id");

  const targetUser = await findUserById(c.env.DB, targetId);
  if (!targetUser) {
    return c.json({ error: { code: "NOT_FOUND", message: "User not found" } }, 404);
  }

  const sessions = await listActiveSessionsByUserId(c.env.DB, targetId);
  return c.json({ data: sessions });
});

// GET /api/users/:id/bff-sessions — ユーザーの BFF セッション一覧（管理者のみ）
app.get("/:id/bff-sessions", authMiddleware, adminMiddleware, async (c) => {
  const targetId = c.req.param("id");

  const targetUser = await findUserById(c.env.DB, targetId);
  if (!targetUser) {
    return c.json({ error: { code: "NOT_FOUND", message: "User not found" } }, 404);
  }

  const sessions = await listActiveBffSessionsByUserId(c.env.DB, targetId);
  return c.json({ data: sessions });
});

// DELETE /api/users/:id/bff-sessions/:sessionId — 単一の BFF セッションを失効（管理者のみ）
app.delete(
  "/:id/bff-sessions/:sessionId",
  authMiddleware,
  adminMiddleware,
  csrfMiddleware,
  async (c) => {
    const targetId = c.req.param("id");
    const sessionId = c.req.param("sessionId");
    if (!UUID_RE.test(sessionId)) {
      return c.json({ error: { code: "BAD_REQUEST", message: "Invalid session ID format" } }, 400);
    }

    const targetUser = await findUserById(c.env.DB, targetId);
    if (!targetUser) {
      return c.json({ error: { code: "NOT_FOUND", message: "User not found" } }, 404);
    }

    const adminUser = c.get("user");
    let revoked: number;
    try {
      revoked = await revokeBffSessionByIdForUser(
        c.env.DB,
        sessionId,
        targetId,
        `admin_action:${adminUser.sub}`,
      );
    } catch (err) {
      await logAdminAudit(c, {
        action: "user.bff_session_revoked",
        targetType: "user",
        targetId,
        details: { sessionId, error: extractErrorMessage(err) },
        status: "failure",
      });
      throw err;
    }

    if (revoked === 0) {
      return c.json({ error: { code: "NOT_FOUND", message: "BFF session not found" } }, 404);
    }

    await logAdminAudit(c, {
      action: "user.bff_session_revoked",
      targetType: "user",
      targetId,
      details: { sessionId },
    });

    return c.body(null, 204);
  },
);

// DELETE /api/users/:id/tokens/:tokenId — ユーザーの特定セッションを失効（管理者のみ）
app.delete("/:id/tokens/:tokenId", authMiddleware, adminMiddleware, csrfMiddleware, async (c) => {
  const targetId = c.req.param("id");
  const tokenId = c.req.param("tokenId");
  if (!UUID_RE.test(tokenId)) {
    return c.json({ error: { code: "BAD_REQUEST", message: "Invalid token ID format" } }, 400);
  }

  const targetUser = await findUserById(c.env.DB, targetId);
  if (!targetUser) {
    return c.json({ error: { code: "NOT_FOUND", message: "User not found" } }, 404);
  }

  let revoked;
  try {
    revoked = await revokeTokenByIdForUser(c.env.DB, tokenId, targetId, "admin_action");
  } catch (err) {
    await logAdminAudit(c, {
      action: "user.session_revoked",
      targetType: "user",
      targetId,
      details: { tokenId, error: extractErrorMessage(err) },
      status: "failure",
    });
    throw err;
  }

  if (revoked === 0) {
    return c.json({ error: { code: "NOT_FOUND", message: "Session not found" } }, 404);
  }

  await logAdminAudit(c, {
    action: "user.session_revoked",
    targetType: "user",
    targetId,
    details: { tokenId },
  });

  return c.body(null, 204);
});

// DELETE /api/users/:id/tokens — ユーザーの全セッション無効化（管理者のみ）
app.delete("/:id/tokens", authMiddleware, adminMiddleware, csrfMiddleware, async (c) => {
  const targetId = c.req.param("id");

  const targetUser = await findUserById(c.env.DB, targetId);
  if (!targetUser) {
    return c.json({ error: { code: "NOT_FOUND", message: "User not found" } }, 404);
  }

  try {
    await revokeUserTokens(c.env.DB, targetId, "admin_action");
    await deleteMcpSessionsByUser(c.env.DB, targetId);
    await logAdminAudit(c, {
      action: "user.sessions_revoked",
      targetType: "user",
      targetId,
    });
  } catch (err) {
    await logAdminAudit(c, {
      action: "user.sessions_revoked",
      targetType: "user",
      targetId,
      details: { error: extractErrorMessage(err) },
      status: "failure",
    });
    throw err;
  }

  return c.body(null, 204);
});

// DELETE /api/users/:id（管理者のみ）
app.delete("/:id", authMiddleware, adminMiddleware, csrfMiddleware, async (c) => {
  const targetId = c.req.param("id");
  const tokenUser = c.get("user");

  if (targetId === tokenUser.sub) {
    return c.json({ error: { code: "FORBIDDEN", message: "Cannot delete yourself" } }, 403);
  }

  const targetUser = await findUserById(c.env.DB, targetId);
  if (!targetUser) {
    return c.json({ error: { code: "NOT_FOUND", message: "User not found" } }, 404);
  }

  const deleteError = await performUserDeletion(c.env.DB, targetId);
  if (deleteError) {
    return c.json({ error: deleteError }, 409);
  }

  await logAdminAudit(c, {
    action: "user.delete",
    targetType: "user",
    targetId,
  });

  return c.body(null, 204);
});

// GET /api/users（管理者のみ）
app.get("/", authMiddleware, adminMiddleware, async (c) => {
  const pagination = requirePagination(c, { defaultLimit: 50, maxLimit: 100 });
  if (pagination instanceof Response) return pagination;
  const { limit, offset } = pagination;

  const filter: UserFilter = {};
  const emailQuery = c.req.query("email");
  const roleQuery = c.req.query("role");
  const nameQuery = c.req.query("name");
  const bannedQuery = c.req.query("banned");

  if (emailQuery) filter.email = emailQuery;
  if (roleQuery === "user" || roleQuery === "admin") filter.role = roleQuery;
  if (nameQuery) filter.name = nameQuery;
  if (bannedQuery === "true") filter.banned = true;
  else if (bannedQuery === "false") filter.banned = false;

  let users, total;
  try {
    [users, total] = await Promise.all([
      listUsers(c.env.DB, limit, offset, filter),
      countUsers(c.env.DB, filter),
    ]);
  } catch (err) {
    usersLogger.error("[users] Failed to fetch users", err);
    return c.json({ error: { code: "INTERNAL_ERROR", message: "Failed to fetch users" } }, 500);
  }
  return c.json({ data: users.map(formatAdminUserSummary), total });
});

export default app;

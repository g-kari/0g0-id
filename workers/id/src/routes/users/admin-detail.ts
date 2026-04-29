import { Hono } from "hono";
import type { IdpEnv, UserFilter } from "@0g0-id/shared";
import {
  listUsers,
  countUsers,
  listUserConnections,
  listServicesByOwner,
  getUserProviders,
  getLoginEventsByUserId,
  getUserLoginProviderStats,
  getUserDailyLoginTrends,
  parseDays,
  paginationMiddleware,
  isValidProvider,
  restErrorBody,
} from "@0g0-id/shared";
import { authMiddleware } from "../../middleware/auth";
import { adminMiddleware } from "../../middleware/admin";
import type { Variables } from "./_shared";
import {
  formatAdminUserDetail,
  formatAdminUserSummary,
  requireTargetUser,
  usersLogger,
} from "./_shared";

const app = new Hono<{ Bindings: IdpEnv; Variables: Variables }>();

// GET /api/users/:id（管理者のみ）
app.get("/:id", authMiddleware, adminMiddleware, async (c) => {
  const targetId = c.req.param("id");
  const result = await requireTargetUser(c.env.DB, targetId);
  if (!result.ok) return c.json(result.error, result.status);
  return c.json({ data: formatAdminUserDetail(result.user) });
});

// GET /api/users/:id/owned-services — ユーザーが所有するサービス一覧（管理者のみ）
app.get("/:id/owned-services", authMiddleware, adminMiddleware, async (c) => {
  const targetId = c.req.param("id");

  const result = await requireTargetUser(c.env.DB, targetId);
  if (!result.ok) return c.json(result.error, result.status);

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

  const result = await requireTargetUser(c.env.DB, targetId);
  if (!result.ok) return c.json(result.error, result.status);

  const connections = await listUserConnections(c.env.DB, targetId);
  return c.json({ data: connections });
});

// GET /api/users/:id/providers — ユーザーのSNSプロバイダー連携状態（管理者のみ）
app.get("/:id/providers", authMiddleware, adminMiddleware, async (c) => {
  const targetId = c.req.param("id");

  const result = await requireTargetUser(c.env.DB, targetId);
  if (!result.ok) return c.json(result.error, result.status);

  const providers = await getUserProviders(c.env.DB, targetId);
  return c.json({ data: providers });
});

// GET /api/users/:id/login-history（管理者のみ）
app.get(
  "/:id/login-history",
  authMiddleware,
  adminMiddleware,
  paginationMiddleware({ defaultLimit: 20, maxLimit: 100 }),
  async (c) => {
    const targetId = c.req.param("id");
    const { limit, offset } = c.get("pagination");
    const providerParam = c.req.query("provider") || undefined;
    if (providerParam !== undefined && !isValidProvider(providerParam)) {
      return c.json(restErrorBody("BAD_REQUEST", "Invalid provider"), 400);
    }

    const result = await requireTargetUser(c.env.DB, targetId);
    if (!result.ok) return c.json(result.error, result.status);

    const { events, total } = await getLoginEventsByUserId(
      c.env.DB,
      targetId,
      limit,
      offset,
      providerParam,
    );
    return c.json({ data: events, total });
  },
);

// GET /api/users/:id/login-stats — ユーザーのプロバイダー別ログイン統計（管理者のみ）
app.get("/:id/login-stats", authMiddleware, adminMiddleware, async (c) => {
  const targetId = c.req.param("id");
  const daysResult = parseDays(c.req.query("days"), { maxDays: 365 });
  if (daysResult && "error" in daysResult) {
    return c.json(restErrorBody("BAD_REQUEST", daysResult.error.message), 400);
  }
  const days = daysResult?.days ?? 30;

  const result = await requireTargetUser(c.env.DB, targetId);
  if (!result.ok) return c.json(result.error, result.status);

  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const stats = await getUserLoginProviderStats(c.env.DB, targetId, sinceIso);
  return c.json({ data: stats, days });
});

// GET /api/users/:id/login-trends — ユーザーの日別ログイントレンド（管理者のみ）
app.get("/:id/login-trends", authMiddleware, adminMiddleware, async (c) => {
  const targetId = c.req.param("id");
  const daysResult = parseDays(c.req.query("days"), { maxDays: 365 });
  if (daysResult && "error" in daysResult) {
    return c.json(restErrorBody("BAD_REQUEST", daysResult.error.message), 400);
  }
  const days = daysResult?.days ?? 30;

  const result = await requireTargetUser(c.env.DB, targetId);
  if (!result.ok) return c.json(result.error, result.status);

  const trends = await getUserDailyLoginTrends(c.env.DB, targetId, days);
  return c.json({ data: trends, days });
});

// GET /api/users（管理者のみ）
app.get(
  "/",
  authMiddleware,
  adminMiddleware,
  paginationMiddleware({ defaultLimit: 50, maxLimit: 100 }),
  async (c) => {
    const { limit, offset } = c.get("pagination");

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
      return c.json(restErrorBody("INTERNAL_ERROR", "Failed to fetch users"), 500);
    }
    return c.json({ data: users.map(formatAdminUserSummary), total });
  },
);

export default app;

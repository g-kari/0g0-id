import { Hono } from "hono";
import {
  listAdminAuditLogs,
  getAuditLogStats,
  paginationMiddleware,
  parseDays,
  restErrorBody,
  UUID_RE,
} from "@0g0-id/shared";
import type { IdpEnv, TokenPayload } from "@0g0-id/shared";
import { authMiddleware } from "../middleware/auth";
import { adminMiddleware } from "../middleware/admin";

type Variables = { user: TokenPayload };

const app = new Hono<{ Bindings: IdpEnv; Variables: Variables }>();

// GET /api/admin/audit-logs/stats — 監査ログ統計（管理者のみ）
app.get("/stats", authMiddleware, adminMiddleware, async (c) => {
  const daysResult = parseDays(c.req.query("days"));
  if (daysResult !== undefined && "error" in daysResult) {
    return c.json({ error: daysResult.error }, 400);
  }
  const days = daysResult?.days ?? 30;

  try {
    const stats = await getAuditLogStats(c.env.DB, days);
    return c.json({ data: stats, days });
  } catch {
    return c.json(restErrorBody("INTERNAL_ERROR", "Internal server error"), 500);
  }
});

// GET /api/admin/audit-logs — 管理者操作の監査ログ一覧（管理者のみ）
app.get(
  "/",
  authMiddleware,
  adminMiddleware,
  paginationMiddleware({ defaultLimit: 50, maxLimit: 100 }),
  async (c) => {
    const { limit, offset } = c.get("pagination");

    const adminUserId = c.req.query("admin_user_id");
    const targetId = c.req.query("target_id");
    const action = c.req.query("action");

    if (adminUserId !== undefined && !UUID_RE.test(adminUserId)) {
      return c.json(restErrorBody("BAD_REQUEST", "Invalid admin_user_id format"), 400);
    }
    if (targetId !== undefined && !UUID_RE.test(targetId)) {
      return c.json(restErrorBody("BAD_REQUEST", "Invalid target_id format"), 400);
    }
    if (action !== undefined && !/^[a-z]+\.[a-z_]+$/.test(action)) {
      return c.json(restErrorBody("BAD_REQUEST", "Invalid action format"), 400);
    }

    try {
      const { logs, total } = await listAdminAuditLogs(c.env.DB, limit, offset, {
        adminUserId,
        targetId,
        action,
      });
      return c.json({
        data: logs,
        pagination: { total, limit, offset },
      });
    } catch {
      return c.json(restErrorBody("INTERNAL_ERROR", "Internal server error"), 500);
    }
  },
);

export default app;

import { Hono } from "hono";
import type { IdpEnv } from "@0g0-id/shared";
import { getAccountLockout, clearLockout } from "@0g0-id/shared";
import { csrfMiddleware } from "../../middleware/csrf";
import { logAdminAudit } from "../../lib/audit";
import type { Variables } from "./_shared";
import { requireTargetUser } from "./_shared";

const app = new Hono<{ Bindings: IdpEnv; Variables: Variables }>();

// GET /api/users/:id/lockout — ユーザーのロックアウト状態（管理者のみ）
app.get("/:id/lockout", async (c) => {
  const targetId = c.req.param("id");

  const result = await requireTargetUser(c.env.DB, targetId);
  if (!result.ok) return c.json(result.error, result.status);

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
app.delete("/:id/lockout", csrfMiddleware, async (c) => {
  const targetId = c.req.param("id");

  const result = await requireTargetUser(c.env.DB, targetId);
  if (!result.ok) return c.json(result.error, result.status);

  await clearLockout(c.env.DB, targetId);

  await logAdminAudit(c, {
    action: "user.lockout_clear",
    targetType: "user",
    targetId,
  });

  return c.json({ data: { message: "Lockout cleared" } });
});

export default app;

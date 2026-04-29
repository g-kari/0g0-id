import { Hono } from "hono";
import type { IdpEnv } from "@0g0-id/shared";
import {
  updateUserRoleWithRevocation,
  banUserWithRevocation,
  unbanUser,
  parseJsonBody,
  restErrorBody,
} from "@0g0-id/shared";
import { csrfMiddleware } from "../../middleware/csrf";
import { logAdminAudit, extractErrorMessage } from "../../lib/audit";
import type { Variables } from "./_shared";
import {
  PatchRoleSchema,
  formatAdminUserSummary,
  performUserDeletion,
  requireTargetUser,
} from "./_shared";

const app = new Hono<{ Bindings: IdpEnv; Variables: Variables }>();

// PATCH /api/users/:id/role（管理者のみ）
app.patch("/:id/role", csrfMiddleware, async (c) => {
  const targetId = c.req.param("id");
  const tokenUser = c.get("user");

  const bodyResult = await parseJsonBody(c, PatchRoleSchema);
  if (!bodyResult.ok) return bodyResult.response;
  const { role } = bodyResult.data;

  if (targetId === tokenUser.sub) {
    return c.json(restErrorBody("FORBIDDEN", "Cannot change your own role"), 403);
  }

  const result = await requireTargetUser(c.env.DB, targetId);
  if (!result.ok) return c.json(result.error, result.status);
  const targetUser = result.user;

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
    return c.json(restErrorBody("INTERNAL_ERROR", "Failed to change user role"), 500);
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
app.patch("/:id/ban", csrfMiddleware, async (c) => {
  const targetId = c.req.param("id");
  const tokenUser = c.get("user");

  if (targetId === tokenUser.sub) {
    return c.json(restErrorBody("FORBIDDEN", "Cannot ban yourself"), 403);
  }

  const result = await requireTargetUser(c.env.DB, targetId);
  if (!result.ok) return c.json(result.error, result.status);
  const targetUser = result.user;

  if (targetUser.role === "admin") {
    return c.json(restErrorBody("FORBIDDEN", "Cannot ban an admin user"), 403);
  }

  if (targetUser.banned_at !== null) {
    return c.json(restErrorBody("CONFLICT", "User is already banned"), 409);
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
    return c.json(restErrorBody("INTERNAL_ERROR", "Failed to ban user"), 500);
  }

  await logAdminAudit(c, {
    action: "user.ban",
    targetType: "user",
    targetId,
  });

  return c.json({ data: formatAdminUserSummary(updated) });
});

// DELETE /api/users/:id/ban — ユーザー停止を解除（管理者のみ）
app.delete("/:id/ban", csrfMiddleware, async (c) => {
  const targetId = c.req.param("id");

  const result = await requireTargetUser(c.env.DB, targetId);
  if (!result.ok) return c.json(result.error, result.status);
  const targetUser = result.user;

  if (targetUser.banned_at === null) {
    return c.json(restErrorBody("CONFLICT", "User is not banned"), 409);
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

// DELETE /api/users/:id（管理者のみ）
app.delete("/:id", csrfMiddleware, async (c) => {
  const targetId = c.req.param("id");
  const tokenUser = c.get("user");

  if (targetId === tokenUser.sub) {
    return c.json(restErrorBody("FORBIDDEN", "Cannot delete yourself"), 403);
  }

  const result = await requireTargetUser(c.env.DB, targetId);
  if (!result.ok) return c.json(result.error, result.status);

  const deleteError = await performUserDeletion(c.env.DB, targetId);
  if (deleteError) {
    return c.json(restErrorBody(deleteError.code, deleteError.message), 409);
  }

  await logAdminAudit(c, {
    action: "user.delete",
    targetType: "user",
    targetId,
  });

  return c.body(null, 204);
});

export default app;

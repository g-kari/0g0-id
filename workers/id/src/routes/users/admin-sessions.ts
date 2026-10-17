import { Hono } from "hono";
import type { IdpEnv } from "@0g0-id/shared";
import {
  revokeUserTokens,
  deleteMcpSessionsByUser,
  revokeAllBffSessionsByUserId,
  revokeBffSessionByIdForUser,
  revokeTokenByIdForUser,
  listActiveSessionsByUserId,
  listActiveBffSessionsByUserId,
  UUID_RE,
  restErrorBody,
} from "@0g0-id/shared";
import { csrfMiddleware } from "../../middleware/csrf";
import { logAdminAudit, extractErrorMessage } from "../../lib/audit";
import type { Variables } from "./_shared";
import { requireTargetUser } from "./_shared";

const app = new Hono<{ Bindings: IdpEnv; Variables: Variables }>();

// GET /api/users/:id/tokens — ユーザーのアクティブセッション一覧（管理者のみ）
app.get("/:id/tokens", async (c) => {
  const targetId = c.req.param("id");

  const result = await requireTargetUser(c.env.DB, targetId);
  if (!result.ok) return c.json(result.error, result.status);

  const sessions = await listActiveSessionsByUserId(c.env.DB, targetId);
  return c.json({ data: sessions });
});

// GET /api/users/:id/bff-sessions — ユーザーの BFF セッション一覧（管理者のみ）
app.get("/:id/bff-sessions", async (c) => {
  const targetId = c.req.param("id");

  const result = await requireTargetUser(c.env.DB, targetId);
  if (!result.ok) return c.json(result.error, result.status);

  const sessions = await listActiveBffSessionsByUserId(c.env.DB, targetId);
  return c.json({ data: sessions });
});

// DELETE /api/users/:id/bff-sessions/:sessionId — 単一の BFF セッションを失効（管理者のみ）
app.delete("/:id/bff-sessions/:sessionId", csrfMiddleware, async (c) => {
  const targetId = c.req.param("id");
  const sessionId = c.req.param("sessionId");
  if (!UUID_RE.test(sessionId)) {
    return c.json(restErrorBody("BAD_REQUEST", "Invalid session ID format"), 400);
  }

  const result = await requireTargetUser(c.env.DB, targetId);
  if (!result.ok) return c.json(result.error, result.status);

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
    return c.json(restErrorBody("NOT_FOUND", "BFF session not found"), 404);
  }

  await logAdminAudit(c, {
    action: "user.bff_session_revoked",
    targetType: "user",
    targetId,
    details: { sessionId },
  });

  return c.body(null, 204);
});

// DELETE /api/users/:id/tokens/:tokenId — ユーザーの特定セッションを失効（管理者のみ）
app.delete("/:id/tokens/:tokenId", csrfMiddleware, async (c) => {
  const targetId = c.req.param("id");
  const tokenId = c.req.param("tokenId");
  if (!UUID_RE.test(tokenId)) {
    return c.json(restErrorBody("BAD_REQUEST", "Invalid token ID format"), 400);
  }

  const result = await requireTargetUser(c.env.DB, targetId);
  if (!result.ok) return c.json(result.error, result.status);

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
    return c.json(restErrorBody("NOT_FOUND", "Session not found"), 404);
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
app.delete("/:id/tokens", csrfMiddleware, async (c) => {
  const targetId = c.req.param("id");

  const result = await requireTargetUser(c.env.DB, targetId);
  if (!result.ok) return c.json(result.error, result.status);

  try {
    await revokeUserTokens(c.env.DB, targetId, "admin_action");
    await deleteMcpSessionsByUser(c.env.DB, targetId);
    await revokeAllBffSessionsByUserId(c.env.DB, targetId, "admin_action");
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

export default app;

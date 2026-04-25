import { Hono } from "hono";
import {
  findServiceById,
  findUserById,
  generateClientSecret,
  sha256,
  rotateClientSecret,
  transferServiceOwnership,
  listUsersAuthorizedForService,
  countUsersAuthorizedForService,
  revokeUserServiceTokens,
  requirePagination,
  UUID_RE,
  restErrorBody,
  parseJsonBody,
} from "@0g0-id/shared";
import type { Service, User } from "@0g0-id/shared";
import { authMiddleware } from "../../middleware/auth";
import { adminMiddleware } from "../../middleware/admin";
import { csrfMiddleware } from "../../middleware/csrf";
import { logAdminAudit } from "../../lib/audit";
import { servicesLogger, TransferOwnerSchema, type ServiceAppEnv } from "./_shared";

const app = new Hono<ServiceAppEnv>();

// POST /api/services/:id/rotate-secret — client_secretの再発行
app.post("/:id/rotate-secret", authMiddleware, adminMiddleware, csrfMiddleware, async (c) => {
  const serviceId = c.req.param("id");
  let service: Service | null;
  try {
    service = await findServiceById(c.env.DB, serviceId);
  } catch (err) {
    servicesLogger.error("[services] Failed to fetch service for secret rotation", err);
    return c.json(restErrorBody("INTERNAL_ERROR", "Internal server error"), 500);
  }
  if (!service) {
    return c.json(restErrorBody("NOT_FOUND", "Service not found"), 404);
  }

  const newClientSecret = generateClientSecret();
  const newClientSecretHash = await sha256(newClientSecret);

  let updated: Service | null;
  try {
    updated = await rotateClientSecret(c.env.DB, serviceId, newClientSecretHash);
  } catch (err) {
    servicesLogger.error("[services] Failed to rotate client secret", err);
    return c.json(restErrorBody("INTERNAL_ERROR", "Internal server error"), 500);
  }
  if (!updated) {
    return c.json(restErrorBody("NOT_FOUND", "Service not found"), 404);
  }

  await logAdminAudit(c, {
    action: "service.secret_rotated",
    targetType: "service",
    targetId: serviceId,
  });

  return c.json({
    data: {
      id: updated.id,
      client_id: updated.client_id,
      client_secret: newClientSecret,
      updated_at: updated.updated_at,
    },
  });
});

// PATCH /api/services/:id/owner — サービス所有権の転送
app.patch("/:id/owner", authMiddleware, adminMiddleware, csrfMiddleware, async (c) => {
  const serviceId = c.req.param("id");

  const result = await parseJsonBody(c, TransferOwnerSchema);
  if (!result.ok) return result.response;
  const { new_owner_user_id } = result.data;

  let service: Service | null;
  let newOwner: User | null;
  try {
    [service, newOwner] = await Promise.all([
      findServiceById(c.env.DB, serviceId),
      findUserById(c.env.DB, new_owner_user_id),
    ]);
  } catch (err) {
    servicesLogger.error("[services] Failed to fetch service/user for ownership transfer", err);
    return c.json(restErrorBody("INTERNAL_ERROR", "Internal server error"), 500);
  }
  if (!service) {
    return c.json(restErrorBody("NOT_FOUND", "Service not found"), 404);
  }
  if (!newOwner) {
    return c.json(restErrorBody("NOT_FOUND", "New owner user not found"), 404);
  }

  let updated: Service | null;
  try {
    updated = await transferServiceOwnership(c.env.DB, serviceId, new_owner_user_id);
  } catch (err) {
    servicesLogger.error("[services] Failed to transfer service ownership", err);
    return c.json(restErrorBody("INTERNAL_ERROR", "Internal server error"), 500);
  }
  if (!updated) {
    return c.json(restErrorBody("NOT_FOUND", "Service not found"), 404);
  }

  await logAdminAudit(c, {
    action: "service.owner_transferred",
    targetType: "service",
    targetId: serviceId,
    details: { from: service.owner_user_id, to: new_owner_user_id },
  });

  return c.json({
    data: {
      id: updated.id,
      name: updated.name,
      client_id: updated.client_id,
      owner_user_id: updated.owner_user_id,
      updated_at: updated.updated_at,
    },
  });
});

// GET /api/services/:id/users — サービスを認可済みのユーザー一覧（管理者のみ）
app.get("/:id/users", authMiddleware, adminMiddleware, async (c) => {
  const serviceId = c.req.param("id");
  const pagination = requirePagination(c, { defaultLimit: 50, maxLimit: 100 });
  if (pagination instanceof Response) return pagination;
  const { limit, offset } = pagination;

  let service: Service | null;
  let users: User[];
  let total: number;
  try {
    [service, [users, total]] = await Promise.all([
      findServiceById(c.env.DB, serviceId),
      Promise.all([
        listUsersAuthorizedForService(c.env.DB, serviceId, limit, offset),
        countUsersAuthorizedForService(c.env.DB, serviceId),
      ]),
    ]);
  } catch (err) {
    servicesLogger.error("[services] Failed to fetch service users", err);
    return c.json(restErrorBody("INTERNAL_ERROR", "Internal server error"), 500);
  }
  if (!service) {
    return c.json(restErrorBody("NOT_FOUND", "Service not found"), 404);
  }

  return c.json({
    data: users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      picture: u.picture,
      role: u.role,
      created_at: u.created_at,
    })),
    total,
  });
});

// DELETE /api/services/:id/users/:userId — ユーザーのサービスアクセスを失効
app.delete("/:id/users/:userId", authMiddleware, adminMiddleware, csrfMiddleware, async (c) => {
  const serviceId = c.req.param("id");
  const userId = c.req.param("userId");
  if (!UUID_RE.test(userId)) {
    return c.json(restErrorBody("BAD_REQUEST", "Invalid user ID format"), 400);
  }

  let service: Service | null;
  let user: User | null;
  try {
    [service, user] = await Promise.all([
      findServiceById(c.env.DB, serviceId),
      findUserById(c.env.DB, userId),
    ]);
  } catch (err) {
    servicesLogger.error("[services] Failed to fetch service/user for access revocation", err);
    return c.json(restErrorBody("INTERNAL_ERROR", "Internal server error"), 500);
  }
  if (!service) {
    return c.json(restErrorBody("NOT_FOUND", "Service not found"), 404);
  }
  if (!user) {
    return c.json(restErrorBody("NOT_FOUND", "User not found"), 404);
  }

  let revokedCount: number;
  try {
    revokedCount = await revokeUserServiceTokens(c.env.DB, userId, serviceId, "admin_action");
  } catch (err) {
    servicesLogger.error("[services] Failed to revoke user service tokens", err);
    return c.json(restErrorBody("INTERNAL_ERROR", "Internal server error"), 500);
  }
  if (revokedCount === 0) {
    return c.json(
      restErrorBody("NOT_FOUND", "User has no active authorization for this service"),
      404,
    );
  }

  await logAdminAudit(c, {
    action: "service.user_access_revoked",
    targetType: "service",
    targetId: serviceId,
    details: { user_id: userId },
  });

  return c.body(null, 204);
});

export default app;

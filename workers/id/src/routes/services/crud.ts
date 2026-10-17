import { Hono } from "hono";
import {
  listServices,
  countServices,
  findServiceById,
  createService,
  updateServiceFields,
  deleteService,
  generateClientId,
  generateClientSecret,
  sha256,
  paginationMiddleware,
  revokeAllServiceTokens,
  restErrorBody,
  parseJsonBody,
} from "@0g0-id/shared";
import type { ServiceSummary, NewServiceResult, Service } from "@0g0-id/shared";
import { authMiddleware } from "../../middleware/auth";
import { adminMiddleware } from "../../middleware/admin";
import { csrfMiddleware } from "../../middleware/csrf";
import { logAdminAudit } from "../../lib/audit";
import {
  servicesLogger,
  CreateServiceSchema,
  PatchServiceSchema,
  type ServiceAppEnv,
} from "./_shared";

const app = new Hono<ServiceAppEnv>();

// GET /api/services
app.get(
  "/",
  authMiddleware,
  adminMiddleware,
  paginationMiddleware({ defaultLimit: 50, maxLimit: 100 }),
  async (c) => {
    const name = c.req.query("name");
    const { limit, offset } = c.get("pagination");

    let services: Service[];
    let total: number;
    try {
      [services, total] = await Promise.all([
        listServices(c.env.DB, { name, limit, offset }),
        countServices(c.env.DB, { name }),
      ]);
    } catch (err) {
      servicesLogger.error("[services] Failed to list services", err);
      return c.json(restErrorBody("INTERNAL_ERROR", "Internal server error"), 500);
    }

    return c.json({
      data: services.map(
        (s): ServiceSummary => ({
          id: s.id,
          name: s.name,
          client_id: s.client_id,
          allowed_scopes: s.allowed_scopes,
          owner_user_id: s.owner_user_id,
          created_at: s.created_at,
        }),
      ),
      total,
      limit,
      offset,
    });
  },
);

// GET /api/services/:id
app.get("/:id", authMiddleware, adminMiddleware, async (c) => {
  const serviceId = c.req.param("id");
  let service: Service | null;
  try {
    service = await findServiceById(c.env.DB, serviceId);
  } catch (err) {
    servicesLogger.error("[services] Failed to fetch service", err);
    return c.json(restErrorBody("INTERNAL_ERROR", "Internal server error"), 500);
  }
  if (!service) {
    return c.json(restErrorBody("NOT_FOUND", "Service not found"), 404);
  }

  return c.json({
    data: {
      id: service.id,
      name: service.name,
      client_id: service.client_id,
      allowed_scopes: service.allowed_scopes,
      owner_user_id: service.owner_user_id,
      created_at: service.created_at,
      updated_at: service.updated_at,
    },
  });
});

// POST /api/services
app.post("/", authMiddleware, adminMiddleware, csrfMiddleware, async (c) => {
  const result = await parseJsonBody(c, CreateServiceSchema);
  if (!result.ok) return result.response;
  const body = result.data;

  const tokenUser = c.get("user");
  const clientId = generateClientId();
  const clientSecret = generateClientSecret();
  const clientSecretHash = await sha256(clientSecret);
  const allowedScopes = JSON.stringify(body.allowed_scopes ?? ["profile", "email"]);

  let service: Service;
  try {
    service = await createService(c.env.DB, {
      id: crypto.randomUUID(),
      name: body.name.trim(),
      clientId,
      clientSecretHash,
      allowedScopes,
      ownerUserId: tokenUser.sub,
    });
  } catch (err) {
    servicesLogger.error("[services] Failed to create service", err);
    return c.json(restErrorBody("INTERNAL_ERROR", "Internal server error"), 500);
  }

  await logAdminAudit(c, {
    action: "service.create",
    targetType: "service",
    targetId: service.id,
    details: { name: service.name, allowed_scopes: body.allowed_scopes ?? ["profile", "email"] },
  });

  // client_secretは作成時のみ返却
  return c.json(
    {
      data: {
        id: service.id,
        name: service.name,
        client_id: service.client_id,
        client_secret: clientSecret,
        allowed_scopes: service.allowed_scopes,
        created_at: service.created_at,
      } satisfies NewServiceResult,
    },
    201,
  );
});

// PATCH /api/services/:id — name または allowed_scopesの更新
app.patch("/:id", authMiddleware, adminMiddleware, csrfMiddleware, async (c) => {
  const serviceId = c.req.param("id");

  const result = await parseJsonBody(c, PatchServiceSchema);
  if (!result.ok) return result.response;
  const { name, allowed_scopes } = result.data;

  let updated: Service | null;
  try {
    updated = await updateServiceFields(c.env.DB, serviceId, {
      ...(name !== undefined ? { name: name.trim() } : {}),
      ...(allowed_scopes !== undefined ? { allowedScopes: JSON.stringify(allowed_scopes) } : {}),
    });
  } catch (err) {
    servicesLogger.error("[services] Failed to update service", err);
    return c.json(restErrorBody("INTERNAL_ERROR", "Internal server error"), 500);
  }

  if (!updated) {
    return c.json(restErrorBody("NOT_FOUND", "Service not found"), 404);
  }

  await logAdminAudit(c, {
    action: "service.update",
    targetType: "service",
    targetId: serviceId,
    details: {
      ...(name !== undefined ? { name } : {}),
      ...(allowed_scopes !== undefined ? { allowed_scopes } : {}),
    },
  });

  return c.json({
    data: {
      id: updated.id,
      name: updated.name,
      client_id: updated.client_id,
      allowed_scopes: updated.allowed_scopes,
      owner_user_id: updated.owner_user_id,
      updated_at: updated.updated_at,
    },
  });
});

// DELETE /api/services/:id
app.delete("/:id", authMiddleware, adminMiddleware, csrfMiddleware, async (c) => {
  const serviceId = c.req.param("id");
  let service: Service | null;
  try {
    service = await findServiceById(c.env.DB, serviceId);
  } catch (err) {
    servicesLogger.error("[services] Failed to fetch service for deletion", err);
    return c.json(restErrorBody("INTERNAL_ERROR", "Internal server error"), 500);
  }
  if (!service) {
    return c.json(restErrorBody("NOT_FOUND", "Service not found"), 404);
  }

  // サービス削除前に全ユーザーのアクティブトークンを失効させる
  let revokedCount: number;
  try {
    revokedCount = await revokeAllServiceTokens(c.env.DB, serviceId, "service_delete");
  } catch (err) {
    servicesLogger.error("[services] Failed to revoke tokens before deletion", err);
    return c.json(restErrorBody("INTERNAL_ERROR", "Internal server error"), 500);
  }
  if (revokedCount > 0) {
    servicesLogger.info(
      `[services] Revoked ${revokedCount} active tokens before deleting service ${serviceId}`,
    );
  }

  try {
    await deleteService(c.env.DB, serviceId);
  } catch (err) {
    servicesLogger.error("[services] Failed to delete service", err);
    return c.json(restErrorBody("INTERNAL_ERROR", "Internal server error"), 500);
  }

  await logAdminAudit(c, {
    action: "service.delete",
    targetType: "service",
    targetId: serviceId,
    details: { name: service.name, revoked_token_count: revokedCount },
  });

  return c.body(null, 204);
});

export default app;

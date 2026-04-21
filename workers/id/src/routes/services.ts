import { Hono } from "hono";
import { z } from "zod";
import {
  listServices,
  countServices,
  findServiceById,
  createService,
  updateServiceFields,
  deleteService,
  listRedirectUris,
  addRedirectUri,
  findRedirectUriById,
  deleteRedirectUri,
  generateClientId,
  generateClientSecret,
  sha256,
  normalizeRedirectUri,
  rotateClientSecret,
  transferServiceOwnership,
  findUserById,
  listUsersAuthorizedForService,
  countUsersAuthorizedForService,
  revokeUserServiceTokens,
  revokeAllServiceTokens,
  requirePagination,
  UUID_RE,
  uuidParamMiddleware,
  createLogger,
} from "@0g0-id/shared";
import type {
  IdpEnv,
  TokenPayload,
  ServiceSummary,
  NewServiceResult,
  Service,
  ServiceRedirectUri,
  User,
} from "@0g0-id/shared";
import { authMiddleware } from "../middleware/auth";
import { adminMiddleware } from "../middleware/admin";
import { csrfMiddleware } from "../middleware/csrf";
import { parseJsonBody } from "@0g0-id/shared";
import { logAdminAudit } from "../lib/audit";

type Variables = { user: TokenPayload };

const servicesLogger = createLogger("services");

// サポートされているスコープの一覧
const SUPPORTED_SCOPES = ["profile", "email", "phone", "address"] as const;

const ScopeEnum = z.enum(SUPPORTED_SCOPES);

const CreateServiceSchema = z.object({
  name: z.string().min(1, "name is required").max(100, "name must be 100 characters or less"),
  allowed_scopes: z.array(ScopeEnum).min(1, "allowed_scopes must not be empty").optional(),
});

const PatchServiceSchema = z
  .object({
    name: z
      .string()
      .min(1, "name must not be empty")
      .max(100, "name must be 100 characters or less")
      .optional(),
    allowed_scopes: z.array(ScopeEnum).min(1, "allowed_scopes must not be empty").optional(),
  })
  .refine((data) => data.name !== undefined || data.allowed_scopes !== undefined, {
    message: "At least one of name or allowed_scopes must be provided",
  });

const AddRedirectUriSchema = z
  .object({
    uri: z.string().min(1, "uri is required").max(2048, "URI must be 2048 characters or less"),
  })
  .refine(
    (data) => {
      try {
        const url = new URL(data.uri);
        const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
        return isLocalhost || url.protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "Redirect URI must use HTTPS (HTTP is only allowed for localhost/127.0.0.1)" },
  );

const TransferOwnerSchema = z.object({
  new_owner_user_id: z.string().min(1, "new_owner_user_id is required"),
});

const app = new Hono<{ Bindings: IdpEnv; Variables: Variables }>();

// サービスID形式検証ミドルウェア（:id パラメータを持つすべてのルートに適用）
app.use("/:id", uuidParamMiddleware("id", { label: "service ID" }));
app.use("/:id/*", uuidParamMiddleware("id", { label: "service ID" }));

// GET /api/services
app.get("/", authMiddleware, adminMiddleware, async (c) => {
  const name = c.req.query("name");
  const pagination = requirePagination(c, { defaultLimit: 50, maxLimit: 100 });
  if (pagination instanceof Response) return pagination;
  const { limit, offset } = pagination;

  let services: Service[];
  let total: number;
  try {
    [services, total] = await Promise.all([
      listServices(c.env.DB, { name, limit, offset }),
      countServices(c.env.DB, { name }),
    ]);
  } catch (err) {
    servicesLogger.error("[services] Failed to list services", err);
    return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
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
});

// GET /api/services/:id
app.get("/:id", authMiddleware, adminMiddleware, async (c) => {
  const serviceId = c.req.param("id");
  let service: Service | null;
  try {
    service = await findServiceById(c.env.DB, serviceId);
  } catch (err) {
    servicesLogger.error("[services] Failed to fetch service", err);
    return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
  }
  if (!service) {
    return c.json({ error: { code: "NOT_FOUND", message: "Service not found" } }, 404);
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
    return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
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
    return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
  }

  if (!updated) {
    return c.json({ error: { code: "NOT_FOUND", message: "Service not found" } }, 404);
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
    return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
  }
  if (!service) {
    return c.json({ error: { code: "NOT_FOUND", message: "Service not found" } }, 404);
  }

  // サービス削除前に全ユーザーのアクティブトークンを失効させる
  let revokedCount: number;
  try {
    revokedCount = await revokeAllServiceTokens(c.env.DB, serviceId, "service_delete");
  } catch (err) {
    servicesLogger.error("[services] Failed to revoke tokens before deletion", err);
    return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
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
    return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
  }

  await logAdminAudit(c, {
    action: "service.delete",
    targetType: "service",
    targetId: serviceId,
    details: { name: service.name, revoked_token_count: revokedCount },
  });

  return c.body(null, 204);
});

// GET /api/services/:id/redirect-uris
app.get("/:id/redirect-uris", authMiddleware, adminMiddleware, async (c) => {
  const serviceId = c.req.param("id");
  let service: Service | null;
  let uris: ServiceRedirectUri[];
  try {
    [service, uris] = await Promise.all([
      findServiceById(c.env.DB, serviceId),
      listRedirectUris(c.env.DB, serviceId),
    ]);
  } catch (err) {
    servicesLogger.error("[services] Failed to fetch redirect URIs", err);
    return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
  }
  if (!service) {
    return c.json({ error: { code: "NOT_FOUND", message: "Service not found" } }, 404);
  }

  return c.json({ data: uris });
});

// POST /api/services/:id/redirect-uris
app.post("/:id/redirect-uris", authMiddleware, adminMiddleware, csrfMiddleware, async (c) => {
  const serviceId = c.req.param("id");
  let service: Service | null;
  try {
    service = await findServiceById(c.env.DB, serviceId);
  } catch (err) {
    servicesLogger.error("[services] Failed to fetch service for redirect URI", err);
    return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
  }
  if (!service) {
    return c.json({ error: { code: "NOT_FOUND", message: "Service not found" } }, 404);
  }

  const result = await parseJsonBody(c, AddRedirectUriSchema);
  if (!result.ok) return result.response;

  const normalized = normalizeRedirectUri(result.data.uri);
  if (!normalized) {
    return c.json({ error: { code: "BAD_REQUEST", message: "Invalid redirect URI" } }, 400);
  }

  let uri;
  try {
    uri = await addRedirectUri(c.env.DB, {
      id: crypto.randomUUID(),
      serviceId,
      uri: normalized,
    });
  } catch (err) {
    servicesLogger.error("[services] Failed to add redirect URI (possibly duplicate)", err);
    return c.json({ error: { code: "CONFLICT", message: "Redirect URI already exists" } }, 409);
  }

  await logAdminAudit(c, {
    action: "service.redirect_uri_added",
    targetType: "service",
    targetId: serviceId,
    details: { uri: normalized },
  });

  return c.json({ data: uri }, 201);
});

// POST /api/services/:id/rotate-secret — client_secretの再発行
app.post("/:id/rotate-secret", authMiddleware, adminMiddleware, csrfMiddleware, async (c) => {
  const serviceId = c.req.param("id");
  let service: Service | null;
  try {
    service = await findServiceById(c.env.DB, serviceId);
  } catch (err) {
    servicesLogger.error("[services] Failed to fetch service for secret rotation", err);
    return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
  }
  if (!service) {
    return c.json({ error: { code: "NOT_FOUND", message: "Service not found" } }, 404);
  }

  const newClientSecret = generateClientSecret();
  const newClientSecretHash = await sha256(newClientSecret);

  let updated: Service | null;
  try {
    updated = await rotateClientSecret(c.env.DB, serviceId, newClientSecretHash);
  } catch (err) {
    servicesLogger.error("[services] Failed to rotate client secret", err);
    return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
  }
  if (!updated) {
    return c.json({ error: { code: "NOT_FOUND", message: "Service not found" } }, 404);
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
    return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
  }
  if (!service) {
    return c.json({ error: { code: "NOT_FOUND", message: "Service not found" } }, 404);
  }
  if (!newOwner) {
    return c.json({ error: { code: "NOT_FOUND", message: "New owner user not found" } }, 404);
  }

  let updated: Service | null;
  try {
    updated = await transferServiceOwnership(c.env.DB, serviceId, new_owner_user_id);
  } catch (err) {
    servicesLogger.error("[services] Failed to transfer service ownership", err);
    return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
  }
  if (!updated) {
    return c.json({ error: { code: "NOT_FOUND", message: "Service not found" } }, 404);
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
    return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
  }
  if (!service) {
    return c.json({ error: { code: "NOT_FOUND", message: "Service not found" } }, 404);
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
    return c.json({ error: { code: "BAD_REQUEST", message: "Invalid user ID format" } }, 400);
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
    return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
  }
  if (!service) {
    return c.json({ error: { code: "NOT_FOUND", message: "Service not found" } }, 404);
  }
  if (!user) {
    return c.json({ error: { code: "NOT_FOUND", message: "User not found" } }, 404);
  }

  let revokedCount: number;
  try {
    revokedCount = await revokeUserServiceTokens(c.env.DB, userId, serviceId, "admin_action");
  } catch (err) {
    servicesLogger.error("[services] Failed to revoke user service tokens", err);
    return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
  }
  if (revokedCount === 0) {
    return c.json(
      {
        error: { code: "NOT_FOUND", message: "User has no active authorization for this service" },
      },
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

// DELETE /api/services/:id/redirect-uris/:uriId
app.delete(
  "/:id/redirect-uris/:uriId",
  authMiddleware,
  adminMiddleware,
  csrfMiddleware,
  async (c) => {
    const serviceId = c.req.param("id");
    const uriId = c.req.param("uriId");
    if (!UUID_RE.test(uriId)) {
      return c.json({ error: { code: "BAD_REQUEST", message: "Invalid URI ID format" } }, 400);
    }

    let service: Service | null;
    let redirectUri: ServiceRedirectUri | null;
    try {
      [service, redirectUri] = await Promise.all([
        findServiceById(c.env.DB, serviceId),
        findRedirectUriById(c.env.DB, uriId, serviceId),
      ]);
    } catch (err) {
      servicesLogger.error("[services] Failed to fetch service/redirect URI for deletion", err);
      return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
    }
    if (!service) {
      return c.json({ error: { code: "NOT_FOUND", message: "Service not found" } }, 404);
    }
    if (!redirectUri) {
      return c.json({ error: { code: "NOT_FOUND", message: "Redirect URI not found" } }, 404);
    }

    try {
      await deleteRedirectUri(c.env.DB, uriId, serviceId);
    } catch (err) {
      servicesLogger.error("[services] Failed to delete redirect URI", err);
      return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
    }

    await logAdminAudit(c, {
      action: "service.redirect_uri_deleted",
      targetType: "service",
      targetId: serviceId,
      details: { uri_id: uriId, uri: redirectUri.uri },
    });

    return c.body(null, 204);
  },
);

export default app;

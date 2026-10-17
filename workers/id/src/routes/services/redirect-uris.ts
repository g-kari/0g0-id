import { Hono } from "hono";
import {
  findServiceById,
  listRedirectUris,
  addRedirectUri,
  findRedirectUriById,
  deleteRedirectUri,
  normalizeRedirectUri,
  UUID_RE,
  restErrorBody,
  parseJsonBody,
} from "@0g0-id/shared";
import type { Service, ServiceRedirectUri } from "@0g0-id/shared";
import { authMiddleware } from "../../middleware/auth";
import { adminMiddleware } from "../../middleware/admin";
import { csrfMiddleware } from "../../middleware/csrf";
import { logAdminAudit } from "../../lib/audit";
import { servicesLogger, AddRedirectUriSchema, type ServiceAppEnv } from "./_shared";

const app = new Hono<ServiceAppEnv>();

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
    return c.json(restErrorBody("INTERNAL_ERROR", "Internal server error"), 500);
  }
  if (!service) {
    return c.json(restErrorBody("NOT_FOUND", "Service not found"), 404);
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
    return c.json(restErrorBody("INTERNAL_ERROR", "Internal server error"), 500);
  }
  if (!service) {
    return c.json(restErrorBody("NOT_FOUND", "Service not found"), 404);
  }

  const result = await parseJsonBody(c, AddRedirectUriSchema);
  if (!result.ok) return result.response;

  const normalized = normalizeRedirectUri(result.data.uri);
  if (!normalized) {
    return c.json(restErrorBody("BAD_REQUEST", "Invalid redirect URI"), 400);
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
    return c.json(restErrorBody("CONFLICT", "Redirect URI already exists"), 409);
  }

  await logAdminAudit(c, {
    action: "service.redirect_uri_added",
    targetType: "service",
    targetId: serviceId,
    details: { uri: normalized },
  });

  return c.json({ data: uri }, 201);
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
      return c.json(restErrorBody("BAD_REQUEST", "Invalid URI ID format"), 400);
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
      return c.json(restErrorBody("INTERNAL_ERROR", "Internal server error"), 500);
    }
    if (!service) {
      return c.json(restErrorBody("NOT_FOUND", "Service not found"), 404);
    }
    if (!redirectUri) {
      return c.json(restErrorBody("NOT_FOUND", "Redirect URI not found"), 404);
    }

    try {
      await deleteRedirectUri(c.env.DB, uriId, serviceId);
    } catch (err) {
      servicesLogger.error("[services] Failed to delete redirect URI", err);
      return c.json(restErrorBody("INTERNAL_ERROR", "Internal server error"), 500);
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

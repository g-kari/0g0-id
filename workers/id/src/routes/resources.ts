import { Hono } from "hono";
import { z } from "zod";
import {
  listResourceServers,
  findResourceServerById,
  findResourceServerByUri,
  createResourceServer,
  updateResourceServer,
  deleteResourceServerWithTokenRevocation,
  normalizeRedirectUri,
  restErrorBody,
  parseJsonBody,
  createLogger,
} from "@0g0-id/shared";
import type { ResourceServer } from "@0g0-id/shared";
import { authMiddleware } from "../middleware/auth";
import { adminMiddleware } from "../middleware/admin";
import { csrfMiddleware } from "../middleware/csrf";
import { logAdminAudit } from "../lib/audit";
import type { ServiceAppEnv } from "./services/_shared";

const resourcesLogger = createLogger("resources");

const app = new Hono<ServiceAppEnv>();

/**
 * RFC 8707 リソースサーバーレジストリの管理 API（管理者専用）。
 *
 * ここに登録した URI だけが resource パラメータとして受け付けられ、
 * アクセストークンの aud になる。allowed_scopes はそのリソース向け
 * トークンに付与できるスコープの上限。
 */

const ScopeToken = z
  .string()
  .regex(/^[\w:.-]+$/, "scope must match RFC 6749 scope-token characters")
  .max(100);

const SubjectId = z
  .string()
  .min(1, "allowed_subjects entries must not be empty")
  .max(128, "allowed_subjects entries must be 128 characters or less");

const CreateResourceSchema = z.object({
  uri: z.string().min(1, "uri is required").max(2048, "uri must be 2048 characters or less"),
  name: z.string().min(1, "name is required").max(100, "name must be 100 characters or less"),
  allowed_scopes: z.array(ScopeToken).min(1, "allowed_scopes must not be empty").max(50),
  // 利用を許可するユーザーID（sub）。省略・空配列は制限なし
  allowed_subjects: z.array(SubjectId).max(100).optional(),
});

const UpdateResourceSchema = z.object({
  name: z.string().min(1, "name is required").max(100, "name must be 100 characters or less"),
  allowed_scopes: z.array(ScopeToken).min(1, "allowed_scopes must not be empty").max(50),
  allowed_subjects: z.array(SubjectId).max(100),
});

function toResponse(resource: ResourceServer) {
  return {
    id: resource.id,
    uri: resource.uri,
    name: resource.name,
    allowed_scopes: resource.allowed_scopes,
    allowed_subjects: resource.allowed_subjects,
    owner_user_id: resource.owner_user_id,
    created_at: resource.created_at,
    updated_at: resource.updated_at,
  };
}

// GET /api/resources
app.get("/", authMiddleware, adminMiddleware, async (c) => {
  try {
    const resources = await listResourceServers(c.env.DB);
    return c.json({ data: resources.map(toResponse), total: resources.length });
  } catch (err) {
    resourcesLogger.error("[resources] Failed to list resource servers", err);
    return c.json(restErrorBody("INTERNAL_ERROR", "Internal server error"), 500);
  }
});

// GET /api/resources/:id
app.get("/:id", authMiddleware, adminMiddleware, async (c) => {
  let resource: ResourceServer | null;
  try {
    resource = await findResourceServerById(c.env.DB, c.req.param("id"));
  } catch (err) {
    resourcesLogger.error("[resources] Failed to fetch resource server", err);
    return c.json(restErrorBody("INTERNAL_ERROR", "Internal server error"), 500);
  }
  if (!resource) {
    return c.json(restErrorBody("NOT_FOUND", "Resource server not found"), 404);
  }
  return c.json({ data: toResponse(resource) });
});

// POST /api/resources
app.post("/", authMiddleware, adminMiddleware, csrfMiddleware, async (c) => {
  const result = await parseJsonBody(c, CreateResourceSchema);
  if (!result.ok) return result.response;
  const body = result.data;

  // URI は認可フロー側の検証と同じ正規化（https 必須・fragment 禁止）を通し、
  // 正規化した値を正規 URI として登録する
  const normalized = normalizeRedirectUri(body.uri);
  if (!normalized) {
    return c.json(restErrorBody("BAD_REQUEST", "uri must be an https URL without a fragment"), 400);
  }

  try {
    const existing = await findResourceServerByUri(c.env.DB, normalized);
    if (existing) {
      return c.json(restErrorBody("BAD_REQUEST", "uri is already registered"), 400);
    }
    const resource = await createResourceServer(c.env.DB, {
      id: crypto.randomUUID(),
      uri: normalized,
      name: body.name.trim(),
      allowedScopes: JSON.stringify(body.allowed_scopes),
      allowedSubjects: JSON.stringify(body.allowed_subjects ?? []),
      ownerUserId: c.get("user").sub,
    });
    await logAdminAudit(c, {
      action: "resource.create",
      targetType: "resource_server",
      targetId: resource.id,
      details: {
        uri: resource.uri,
        allowed_scopes: body.allowed_scopes,
        allowed_subjects: body.allowed_subjects ?? [],
      },
    });
    return c.json({ data: toResponse(resource) }, 201);
  } catch (err) {
    resourcesLogger.error("[resources] Failed to create resource server", err);
    return c.json(restErrorBody("INTERNAL_ERROR", "Internal server error"), 500);
  }
});

// PUT /api/resources/:id
app.put("/:id", authMiddleware, adminMiddleware, csrfMiddleware, async (c) => {
  const id = c.req.param("id");
  const result = await parseJsonBody(c, UpdateResourceSchema);
  if (!result.ok) return result.response;
  const body = result.data;

  try {
    const existing = await findResourceServerById(c.env.DB, id);
    if (!existing) {
      return c.json(restErrorBody("NOT_FOUND", "Resource server not found"), 404);
    }
    const resource = await updateResourceServer(c.env.DB, id, {
      name: body.name.trim(),
      allowedScopes: JSON.stringify(body.allowed_scopes),
      allowedSubjects: JSON.stringify(body.allowed_subjects),
    });
    if (!resource) {
      return c.json(restErrorBody("NOT_FOUND", "Resource server not found"), 404);
    }
    await logAdminAudit(c, {
      action: "resource.update",
      targetType: "resource_server",
      targetId: id,
      details: {
        uri: resource.uri,
        allowed_scopes: body.allowed_scopes,
        allowed_subjects: body.allowed_subjects,
      },
    });
    return c.json({ data: toResponse(resource) });
  } catch (err) {
    resourcesLogger.error("[resources] Failed to update resource server", err);
    return c.json(restErrorBody("INTERNAL_ERROR", "Internal server error"), 500);
  }
});

// DELETE /api/resources/:id
app.delete("/:id", authMiddleware, adminMiddleware, csrfMiddleware, async (c) => {
  const id = c.req.param("id");
  try {
    const resource = await findResourceServerById(c.env.DB, id);
    if (!resource) {
      return c.json(restErrorBody("NOT_FOUND", "Resource server not found"), 404);
    }
    // 削除と同時に、この resource に束縛された refresh token を全て失効させる。
    // 失効させないと削除後も refresh で同じ aud のトークンが新規発行され続ける。
    // 失効と削除は1トランザクションで原子的に行い、その間隙に refresh が
    // 割り込んで後継トークンを作る余地を残さない（発行側は resource の
    // 登録世代ガード付き INSERT で対向）。失効は永続的なので、同 URI を
    // 再登録しても旧 grant は復活しない。
    const revokedCount = await deleteResourceServerWithTokenRevocation(c.env.DB, resource);
    await logAdminAudit(c, {
      action: "resource.delete",
      targetType: "resource_server",
      targetId: id,
      details: { uri: resource.uri, revoked_refresh_tokens: revokedCount },
    });
    return c.body(null, 204);
  } catch (err) {
    resourcesLogger.error("[resources] Failed to delete resource server", err);
    return c.json(restErrorBody("INTERNAL_ERROR", "Internal server error"), 500);
  }
});

export default app;

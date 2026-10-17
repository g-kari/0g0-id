import { Hono } from "hono";
import { findServiceById, findUserById, generatePairwiseSub, restErrorBody } from "@0g0-id/shared";
import type { ServiceOwnerSub } from "@0g0-id/shared";
import { authMiddleware } from "../../middleware/auth";
import { adminMiddleware } from "../../middleware/admin";
import type { ServiceAppEnv } from "./_shared";

const app = new Hono<ServiceAppEnv>();

// Read-only: the subject is derived from the current service owner, never caller input.
app.get("/:id/owner-sub", authMiddleware, adminMiddleware, async (c): Promise<Response> => {
  if (new URL(c.req.url).searchParams.size > 0) {
    return c.json(restErrorBody("BAD_REQUEST", "Query parameters are not supported"), 400);
  }

  try {
    const service = await findServiceById(c.env.DB, c.req.param("id"));
    if (!service) return c.json(restErrorBody("NOT_FOUND", "Service not found"), 404);

    const owner = await findUserById(c.env.DB, service.owner_user_id);
    if (!owner) return c.json(restErrorBody("NOT_FOUND", "Service owner not found"), 404);

    const sub = await generatePairwiseSub(service.client_id, owner.id, c.env.PAIRWISE_SALT);
    return c.json({
      data: {
        service_id: service.id,
        client_id: service.client_id,
        owner_user_id: owner.id,
        sub,
      } satisfies ServiceOwnerSub,
    });
  } catch {
    // Do not log the subject, salt, DB rows, or exception contents.
    return c.json(restErrorBody("INTERNAL_ERROR", "Internal server error"), 500);
  }
});

export default app;

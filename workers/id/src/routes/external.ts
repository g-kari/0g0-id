import { Hono } from "hono";
import {
  findUserById,
  findUserIdByPairwiseSub,
  generatePairwiseSub,
  createRelyingPartyClaims,
  listUsersAuthorizedForService,
  countUsersAuthorizedForService,
  paginationMiddleware,
  restErrorBody,
} from "@0g0-id/shared";
import type { IdpEnv, User, Service, AuthorizedUserFilter } from "@0g0-id/shared";
import { serviceAuthMiddleware } from "../utils/service-auth";
import { externalApiRateLimitMiddleware } from "../middleware/rate-limit";

type Variables = { service: Service };

const app = new Hono<{ Bindings: IdpEnv; Variables: Variables }>();

/** Services receive only their pairwise subject until explicit user disclosure consent exists. */
async function buildUserData(
  service: Service,
  user: User,
  pairwiseSalt?: string,
): Promise<{ sub: string }> {
  const sub = await generatePairwiseSub(service.client_id, user.id, pairwiseSalt);
  return createRelyingPartyClaims(sub);
}

// GET /api/external/users — 認可済みユーザー一覧（外部サービス向け）
app.get(
  "/users",
  externalApiRateLimitMiddleware,
  serviceAuthMiddleware,
  paginationMiddleware({ defaultLimit: 50, maxLimit: 100 }),
  async (c) => {
    const service = c.get("service");
    const { limit, offset } = c.get("pagination");

    const nameQuery = c.req.query("name");
    const emailQuery = c.req.query("email");

    if (nameQuery !== undefined || emailQuery !== undefined) {
      return c.json(
        restErrorBody("FORBIDDEN", "Personal-information filters require explicit user consent"),
        403,
      );
    }

    const filter: AuthorizedUserFilter = {};

    let users: User[];
    let total: number;
    try {
      [users, total] = await Promise.all([
        listUsersAuthorizedForService(c.env.DB, service.id, limit, offset, filter),
        countUsersAuthorizedForService(c.env.DB, service.id, filter),
      ]);
    } catch {
      return c.json(restErrorBody("INTERNAL_ERROR", "Internal server error"), 500);
    }

    // listUsersAuthorizedForService のSQLで banned_at IS NULL フィルタ済み
    const data = await Promise.all(
      users.map((user) => buildUserData(service, user, c.env.PAIRWISE_SALT)),
    );

    return c.json({ data, meta: { total, limit, offset } });
  },
);

// GET /api/external/users/:sub — ペアワイズsubによるユーザー検索（外部サービス向け）
app.get("/users/:sub", externalApiRateLimitMiddleware, serviceAuthMiddleware, async (c) => {
  const service = c.get("service");
  const requestedSub = c.req.param("sub");
  if (!/^[0-9a-f]{64}$/i.test(requestedSub)) {
    return c.json(restErrorBody("BAD_REQUEST", "Invalid sub format"), 400);
  }

  try {
    // pairwise_subカラムによるインデックス検索（O(1)）
    const matchedUserId = await findUserIdByPairwiseSub(c.env.DB, service.id, requestedSub);

    if (!matchedUserId) {
      return c.json(restErrorBody("NOT_FOUND", "User not found"), 404);
    }

    const user = await findUserById(c.env.DB, matchedUserId);
    if (!user) {
      return c.json(restErrorBody("NOT_FOUND", "User not found"), 404);
    }
    // BAN済みユーザーは外部サービスに公開しない
    if (user.banned_at !== null) {
      return c.json(restErrorBody("NOT_FOUND", "User not found"), 404);
    }

    const data = await buildUserData(service, user, c.env.PAIRWISE_SALT);

    return c.json({ data });
  } catch {
    return c.json(restErrorBody("INTERNAL_ERROR", "Internal server error"), 500);
  }
});

export default app;

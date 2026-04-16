import { Hono } from "hono";
import {
  findUserById,
  findUserIdByPairwiseSub,
  generatePairwiseSub,
  listUsersAuthorizedForService,
  countUsersAuthorizedForService,
  parsePagination,
  restErrorBody,
} from "@0g0-id/shared";
import type { IdpEnv, User, Service, AuthorizedUserFilter } from "@0g0-id/shared";
import { serviceAuthMiddleware } from "../utils/service-auth";
import { parseAllowedScopes } from "../utils/scopes";
import { externalApiRateLimitMiddleware } from "../middleware/rate-limit";

type Variables = { service: Service };

const app = new Hono<{ Bindings: IdpEnv; Variables: Variables }>();

// スコープ→フィールド抽出のマップ（スコープ追加時はここに追記するだけ）
const SCOPE_FIELDS: Record<string, (u: User) => Record<string, unknown>> = {
  profile: (u) => ({ name: u.name, picture: u.picture }),
  email: (u) => ({ email: u.email, email_verified: u.email_verified === 1 }),
  phone: (u) => ({ phone: u.phone }),
  address: (u) => ({ address: u.address }),
};

/**
 * スコープに基づいてユーザー情報をフィルタリングし、外部向けレスポンスを構築する。
 * 内部IDの代わりにペアワイズsubを返す。
 */
async function buildUserData(
  service: Service,
  user: User,
  allowedScopes: string[],
): Promise<Record<string, unknown>> {
  const sub = await generatePairwiseSub(service.client_id, user.id);
  const data: Record<string, unknown> = { sub };
  for (const scope of allowedScopes) {
    if (scope in SCOPE_FIELDS) {
      Object.assign(data, SCOPE_FIELDS[scope](user));
    }
  }
  return data;
}

// GET /api/external/users — 認可済みユーザー一覧（外部サービス向け）
app.get("/users", externalApiRateLimitMiddleware, serviceAuthMiddleware, async (c) => {
  const service = c.get("service");

  const pagination = parsePagination(
    { limit: c.req.query("limit"), offset: c.req.query("offset") },
    { defaultLimit: 50, maxLimit: 100 },
  );
  if ("error" in pagination) {
    return c.json({ error: pagination.error }, 400);
  }
  const { limit, offset } = pagination;

  const nameQuery = c.req.query("name");
  const emailQuery = c.req.query("email");

  const allowedScopes = parseAllowedScopes(service.allowed_scopes);

  if (nameQuery && !allowedScopes.includes("profile")) {
    return c.json(restErrorBody("FORBIDDEN", "name filter requires profile scope"), 403);
  }
  if (emailQuery && !allowedScopes.includes("email")) {
    return c.json(restErrorBody("FORBIDDEN", "email filter requires email scope"), 403);
  }

  const filter: AuthorizedUserFilter = {
    ...(nameQuery ? { name: nameQuery } : {}),
    ...(emailQuery ? { email: emailQuery } : {}),
  };

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
  const data = await Promise.all(users.map((user) => buildUserData(service, user, allowedScopes)));

  return c.json({ data, meta: { total, limit, offset } });
});

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

    const allowedScopes = parseAllowedScopes(service.allowed_scopes);
    const data = await buildUserData(service, user, allowedScopes);

    return c.json({ data });
  } catch {
    return c.json(restErrorBody("INTERNAL_ERROR", "Internal server error"), 500);
  }
});

export default app;

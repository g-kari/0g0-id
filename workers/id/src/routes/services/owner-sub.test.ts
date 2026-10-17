import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Hono } from "hono";

vi.mock("@0g0-id/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@0g0-id/shared")>();
  return { ...actual, verifyAccessToken: vi.fn(), isAccessTokenRevoked: vi.fn() };
});

import { generatePairwiseSub, isAccessTokenRevoked, verifyAccessToken } from "@0g0-id/shared";
import type { IdpEnv, Service, TokenPayload, User } from "@0g0-id/shared";
import { createMockIdpEnv } from "../../../../../packages/shared/src/db/test-helpers";
import routes from "./index";

const SERVICE_ID = "a0000000-0000-0000-0000-000000000001";
const ADMIN_ID = "a0000000-0000-0000-0000-000000000002";
const OWNER_ID = "a0000000-0000-0000-0000-000000000003";
const payload: TokenPayload = {
  iss: "https://id.0g0.xyz",
  sub: ADMIN_ID,
  aud: "https://id.0g0.xyz",
  exp: 2000000000,
  iat: 1900000000,
  jti: "synthetic-jti",
  kid: "synthetic-kid",
  email: "admin@example.invalid",
  role: "admin",
};
const service: Service = {
  id: SERVICE_ID,
  name: "Synthetic service",
  client_id: "synthetic-client",
  client_secret_hash: "must-not-leak",
  allowed_scopes: '["profile"]',
  owner_user_id: OWNER_ID,
  created_at: "2026-10-16T00:00:00Z",
  updated_at: "2026-10-16T00:00:00Z",
};
function user(id: string): User {
  return {
    id,
    google_sub: null,
    line_sub: null,
    twitch_sub: null,
    github_sub: null,
    x_sub: null,
    email: "synthetic@example.invalid",
    email_verified: 1,
    name: "Synthetic",
    picture: null,
    phone: null,
    address: null,
    role: "admin",
    banned_at: null,
    created_at: "2026-10-16T00:00:00Z",
    updated_at: "2026-10-16T00:00:00Z",
  };
}

function fixture(
  options: {
    service?: Service | null;
    owner?: User | null;
    admin?: User | null;
    salt?: string;
    failService?: boolean;
    failOwner?: boolean;
  } = {},
): { env: IdpEnv; sql: string[]; request: (suffix?: string, auth?: boolean) => Promise<Response> } {
  const sql: string[] = [];
  const db = {
    prepare(query: string) {
      sql.push(query);
      if (!query.startsWith("SELECT ")) throw new Error("Unexpected write");
      return {
        bind(id: string) {
          return {
            async first(): Promise<unknown> {
              if (query === "SELECT * FROM services WHERE id = ?") {
                if (options.failService) throw new Error("must-not-leak-service-salt-token");
                return options.service === undefined ? service : options.service;
              }
              if (query === "SELECT * FROM users WHERE id = ?") {
                if (id === ADMIN_ID)
                  return options.admin === undefined ? user(ADMIN_ID) : options.admin;
                if (options.failOwner) throw new Error("must-not-leak-owner-salt-token");
                return options.owner === undefined ? user(id) : options.owner;
              }
              throw new Error("Unexpected query");
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  const env = createMockIdpEnv({ DB: db, PAIRWISE_SALT: options.salt });
  const app = new Hono<{ Bindings: IdpEnv }>();
  app.route("/api/services", routes);
  return {
    env,
    sql,
    request: async (suffix = "", auth = true) =>
      app.request(
        `https://id.0g0.xyz/api/services/${SERVICE_ID}/owner-sub${suffix}`,
        { headers: auth ? { Authorization: "Bearer synthetic-token" } : {} },
        env,
      ),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(verifyAccessToken).mockResolvedValue(payload);
  vi.mocked(isAccessTokenRevoked).mockResolvedValue(false);
});

describe("GET /api/services/:id/owner-sub", () => {
  it("401 without authentication; no database reads", async () => {
    const f = fixture();
    const res = await f.request("", false);
    expect(res.status).toBe(401);
    expect(f.sql).toEqual([]);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
  it("403 for a non-admin; no subject lookup", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue({ ...payload, role: "user" });
    const f = fixture();
    expect((await f.request()).status).toBe(403);
    expect(f.sql).toEqual([]);
  });
  it("401 for revoked tokens", async () => {
    vi.mocked(isAccessTokenRevoked).mockResolvedValue(true);
    const f = fixture();
    expect((await f.request()).status).toBe(401);
    expect(f.sql).toEqual([]);
  });
  it("401 without jti", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue({
      ...payload,
      jti: undefined,
    } as unknown as TokenPayload);
    expect((await fixture().request()).status).toBe(401);
  });
  it.each([null, { ...user(ADMIN_ID), banned_at: "2026-10-15T00:00:00Z" }])(
    "401 for missing/banned admin",
    async (admin) => {
      const f = fixture({ admin });
      expect((await f.request()).status).toBe(401);
      expect(f.sql).not.toContain("SELECT * FROM services WHERE id = ?");
    },
  );
  it("400 for malformed UUID", async () => {
    const f = fixture();
    const app = new Hono<{ Bindings: IdpEnv }>();
    app.route("/api/services", routes);
    const res = await app.request(
      "https://id.0g0.xyz/api/services/not-a-uuid/owner-sub",
      {},
      f.env,
    );
    expect(res.status).toBe(400);
    expect(f.sql).toEqual([]);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
  it.each([
    "?user_id=someone",
    "?client_id=other",
    "?owner_user_id=other",
    "?sub=other",
    "?client_id=a&client_id=b",
  ])("400 rejects caller inputs %s", async (query) => {
    const f = fixture();
    expect((await f.request(query)).status).toBe(400);
    expect(f.sql).not.toContain("SELECT * FROM services WHERE id = ?");
  });
  it("404 for missing service", async () => {
    expect((await fixture({ service: null }).request()).status).toBe(404);
  });
  it("404 for missing current owner", async () => {
    expect((await fixture({ owner: null }).request()).status).toBe(404);
  });
  it.each([undefined, "synthetic-salt"])(
    "matches the real helper without any prior authorization (%s)",
    async (salt) => {
      const f = fixture({ salt });
      const res = await f.request();
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(await res.json()).toEqual({
        data: {
          service_id: SERVICE_ID,
          client_id: service.client_id,
          owner_user_id: OWNER_ID,
          sub: await generatePairwiseSub(service.client_id, OWNER_ID, salt),
        },
      });
      expect(f.sql).toEqual([
        "SELECT * FROM users WHERE id = ?",
        "SELECT * FROM services WHERE id = ?",
        "SELECT * FROM users WHERE id = ?",
      ]); // no token, authorization, audit, INSERT, UPDATE or DELETE access
    },
  );
  it("changes with client, current owner and salt", async () => {
    const getSub = async (f: ReturnType<typeof fixture>): Promise<string> => {
      const body = await (await f.request()).json<{ data: { sub: string } }>();
      return body.data.sub;
    };
    const subs = await Promise.all([
      getSub(fixture({ salt: "salt-a" })),
      getSub(fixture({ salt: "salt-a", service: { ...service, client_id: "client-b" } })),
      getSub(
        fixture({ salt: "salt-a", service: { ...service, owner_user_id: "different-owner" } }),
      ),
      getSub(fixture({ salt: "salt-b" })),
    ]);
    expect(new Set(subs).size).toBe(4);
  });
  it.each([{ failService: true }, { failOwner: true }])(
    "fixed 500 without raw errors or logs for DB failures",
    async (options) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await fixture(options).request();
      expect(res.status).toBe(500);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(await res.json()).toEqual({
        error: { code: "INTERNAL_ERROR", message: "Internal server error" },
      });
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    },
  );
  it("fixed 500 when subject derivation fails", async () => {
    vi.spyOn(crypto.subtle, "digest").mockRejectedValueOnce(new Error("must-not-leak-salt"));
    const res = await fixture({ salt: "synthetic-salt" }).request();
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("must-not-leak");
  });
});

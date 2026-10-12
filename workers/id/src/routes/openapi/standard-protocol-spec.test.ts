import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { Hono } from "hono";
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";
import { signAccessToken, type IdpEnv, type User } from "@0g0-id/shared";
import { createMockIdpEnv } from "../../../../../packages/shared/src/db/test-helpers";
import { app as fullApp } from "../../index";
import { resolveEffectiveScope } from "../../utils/scopes";
import tokenRoutes from "../token";
import deviceRoutes from "../device";
import userInfoRoutes from "../userinfo";
import { issueTokenPair } from "../../utils/token-pair";
import { INTERNAL_OPENAPI } from "./internal-spec";
import { EXTERNAL_OPENAPI } from "./external-spec";
import { validateOpenApiSpec, openApiToMarkdown } from "./markdown";

const origin = "https://synthetic-id.invalid";
const clientId = "synthetic-client";
const grant = "urn:ietf:params:oauth:grant-type:device_code";
const user: User = {
  id: "synthetic-user",
  google_sub: null,
  line_sub: null,
  twitch_sub: null,
  github_sub: null,
  x_sub: null,
  email: "synthetic@example.invalid",
  email_verified: 1,
  name: "Synthetic User",
  picture: null,
  phone: "fixture-phone",
  address: "fixture-address",
  role: "user",
  banned_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
};
const service = {
  id: "synthetic-service",
  client_id: clientId,
  name: "Synthetic Service",
  client_secret_hash: "synthetic-confidential-marker",
  allowed_scopes: '["profile","phone","address"]',
};
const device = {
  id: "synthetic-device",
  device_code_hash: "unused",
  user_code: "ABCDEFGH",
  service_id: service.id,
  scope: "openid",
  expires_at: "2099-01-01T00:00:00Z",
  user_id: null,
  approved_at: null,
  denied_at: null,
  last_polled_at: null,
};
let env: IdpEnv;
let pollingChanges = 1;
let deviceVisible = true;
const queries: string[] = [];
const db = {
  prepare(sql: string): unknown {
    queries.push(sql);
    return {
      bind: vi.fn().mockReturnThis(),
      first: async (): Promise<unknown> => {
        if (sql.includes("FROM services")) return service;
        if (sql.includes("FROM users")) return user;
        if (sql.includes("FROM device_codes")) return deviceVisible ? device : null;
        return null;
      },
      run: async (): Promise<unknown> => ({
        meta: { changes: sql.includes("last_polled_at") ? pollingChanges : 1 },
      }),
    };
  },
} as unknown as D1Database;
const app = new Hono<{ Bindings: IdpEnv }>()
  .route("/api/token", tokenRoutes)
  .route("/api/device", deviceRoutes)
  .route("/api/userinfo", userInfoRoutes);
const fetchGuard = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
  throw new Error("External network forbidden in synthetic contract tests");
});

beforeAll(async (): Promise<void> => {
  const keys = await generateKeyPair("ES256", { extractable: true });
  env = createMockIdpEnv({
    DB: db,
    IDP_ORIGIN: origin,
    USER_ORIGIN: "https://synthetic-user.invalid",
    JWT_PRIVATE_KEY: await exportPKCS8(keys.privateKey),
    JWT_PUBLIC_KEY: await exportSPKI(keys.publicKey),
    PAIRWISE_SALT: "synthetic-only-salt",
  });
});
afterAll((): void => {
  fetchGuard.mockRestore();
});

async function request(
  path: string,
  method: string,
  body?: string,
  headers: Record<string, string> = {},
  bindings = env,
): Promise<Response> {
  return app.request(new Request(origin + path, { method, body, headers }), undefined, bindings);
}
// Full application covers the shared body limit and onError envelope omitted by router-only fixtures.
async function fullRequest(
  path: string,
  method: string,
  body?: string,
  headers: Record<string, string> = {},
  bindings = env,
): Promise<Response> {
  return fullApp.request(
    new Request(origin + path, { method, body, headers }),
    undefined,
    bindings,
  );
}
async function bearer(scope?: string, cid?: string): Promise<string> {
  return signAccessToken(
    { iss: origin, aud: origin, sub: user.id, email: user.email, role: user.role, scope, cid },
    env.JWT_PRIVATE_KEY,
    env.JWT_PUBLIC_KEY,
  );
}

describe("standard protocol documentation matches existing contracts", () => {
  for (const [name, spec] of [
    ["internal", INTERNAL_OPENAPI],
    ["external", EXTERNAL_OPENAPI],
  ] as const) {
    it(`${name}: renders all four missing operations and no fictitious device token route`, (): void => {
      validateOpenApiSpec(spec);
      const md = openApiToMarkdown(spec);
      for (const path of [
        "/api/token",
        "/api/device/code",
        "/api/device/verify",
        "/api/userinfo",
      ]) {
        expect(md).toContain(`### POST ${path}`);
        expect(app.routes.some((r) => r.method === "POST" && r.path === path)).toBe(true);
      }
      expect(md).toContain("### GET /api/userinfo");
      expect(md).not.toContain("### POST /api/device/token");
    });
    it(`${name}: preserves form-only grants and conditional client authentication`, (): void => {
      const op = spec.paths["/api/token"].post;
      expect(Object.keys(op.requestBody.content)).toEqual(["application/x-www-form-urlencoded"]);
      expect(op.security).toEqual([{ BasicAuth: [] }, {}]);
      const branches = op.requestBody.content["application/x-www-form-urlencoded"].schema.oneOf;
      expect(branches.map((b) => b.properties.grant_type.enum[0])).toEqual([
        "authorization_code",
        "refresh_token",
        grant,
      ]);
      expect(branches[2].required).toEqual(["grant_type", "device_code", "client_id"]);
      expect(op.responses["400"].content["application/json"].schema.required).toEqual(["error"]);
      expect(op.responses["400"].headers["Retry-After"].schema.enum).toEqual(["10"]);
      expect(op.responses["429"].headers["Retry-After"].schema.enum).toEqual(["60"]);
    });
    it(`${name}: distinguishes public device start from authenticated verification`, (): void => {
      expect(spec.paths["/api/device/code"].post.security).toEqual([]);
      expect(Object.keys(spec.paths["/api/device/code"].post.requestBody.content)).toEqual([
        "application/x-www-form-urlencoded",
        "application/json",
      ]);
      expect(spec.paths["/api/device/verify"].post.security).toEqual([{ BearerAuth: [] }]);
      expect(spec.paths["/api/device/verify"].post.description).toContain(
        "外部service tokenでは利用できない",
      );
      expect(spec.paths["/api/device/verify"].post.responses["404"].description).toContain(
        "cleanupで削除済み",
      );
      expect(spec.paths["/api/device/code"].post.responses["500"].description).toContain(
        "JSON null",
      );
      expect(spec.paths["/api/token"].post.description).toContain("null/空の保存値はopenidのみ");
      expect(
        spec.paths["/api/device/verify"].post.responses["404"].content["application/json"].schema
          .$ref,
      ).toBe("#/components/schemas/Error");
    });
    it(`${name}: GET/POST UserInfo share scoped flat claims and audience caveat`, (): void => {
      const get = spec.paths["/api/userinfo"].get;
      const post = spec.paths["/api/userinfo"].post;
      expect(post.responses).toBe(get.responses);
      expect(post.security).toEqual([{ BearerAuth: [] }]);
      expect(post).not.toHaveProperty("requestBody");
      expect(post.description).toContain("aud=IDP_ORIGIN");
      expect(post.description).toContain("aud=client_id");
      expect(post.responses["200"].content["application/json"].schema.required).toEqual([
        "sub",
        "updated_at",
      ]);
    });
  }
  it("actual token route refuses JSON and abbreviated/unknown grants", async (): Promise<void> => {
    let response = await request(
      "/api/token",
      "POST",
      JSON.stringify({ grant_type: "refresh_token" }),
      { "Content-Type": "application/json" },
    );
    expect(response.status).toBe(400);
    expect((await response.json<{ error: string }>()).error).toBe("invalid_request");
    for (const value of ["device_code", "unknown", ""]) {
      response = await request(
        "/api/token",
        "POST",
        new URLSearchParams({ grant_type: value }).toString(),
        { "Content-Type": "application/x-www-form-urlencoded" },
      );
      expect(response.status).toBe(400);
      expect((await response.json<{ error: string }>()).error).toBe("unsupported_grant_type");
    }
  });
  it("actual device polling requires body client_id even with Basic", async (): Promise<void> => {
    const response = await request(
      "/api/token",
      "POST",
      new URLSearchParams({ grant_type: grant, device_code: "synthetic-code" }).toString(),
      {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + btoa(clientId + ":synthetic-unused"),
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_request",
      error_description: "client_id is required",
    });
  });
  it("actual device start accepts JSON/form without Basic and returns six flat fields", async (): Promise<void> => {
    for (const type of ["application/json", "application/x-www-form-urlencoded"]) {
      const body =
        type === "application/json"
          ? JSON.stringify({ client_id: clientId })
          : new URLSearchParams({ client_id: clientId }).toString();
      const response = await request("/api/device/code", "POST", body, { "Content-Type": type });
      expect(response.status).toBe(200);
      const result = await response.json<Record<string, unknown>>();
      expect(Object.keys(result).sort()).toEqual([
        "device_code",
        "expires_in",
        "interval",
        "user_code",
        "verification_uri",
        "verification_uri_complete",
      ]);
      expect(result.device_code).toHaveLength(64);
      expect(result.user_code).toMatch(
        /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/,
      );
      expect(result.expires_in).toBe(600);
      expect(result.interval).toBe(5);
      expect(result.verification_uri).toBe(env.USER_ORIGIN + "/device");
    }
  });
  it("actual pending/slow_down OAuth errors omit descriptions and use 400/10, not 429/60", async (): Promise<void> => {
    const body = new URLSearchParams({
      grant_type: grant,
      device_code: "synthetic-code",
      client_id: clientId,
    }).toString();
    pollingChanges = 1;
    const pending = await request("/api/token", "POST", body, {
      "Content-Type": "application/x-www-form-urlencoded",
    });
    expect(pending.status).toBe(400);
    expect(await pending.json()).toEqual({ error: "authorization_pending" });
    pollingChanges = 0;
    const slow = await request("/api/token", "POST", body, {
      "Content-Type": "application/x-www-form-urlencoded",
    });
    expect(slow.status).toBe(400);
    expect(slow.headers.get("Retry-After")).toBe("10");
    expect(await slow.json()).toEqual({ error: "slow_down" });
    pollingChanges = 1;
  });
  it("actual device verification refuses service cid and permits BFF information lookup", async (): Promise<void> => {
    const body = JSON.stringify({ user_code: "abcd-efgh" });
    const rejected = await request("/api/device/verify", "POST", body, {
      "Content-Type": "application/json",
      Authorization: "Bearer " + (await bearer("openid", clientId)),
    });
    expect(rejected.status).toBe(403);
    expect((await rejected.json<{ error: { code: string } }>()).error.code).toBe("FORBIDDEN");
    const accepted = await request("/api/device/verify", "POST", body, {
      "Content-Type": "application/json",
      Authorization: "Bearer " + (await bearer()),
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({
      data: { service_name: service.name, scopes: ["openid"] },
    });
  });
  for (const method of ["GET", "POST"]) {
    it(`actual ${method} UserInfo uses real JWT and omits unrequested phone/address`, async (): Promise<void> => {
      const response = await request("/api/userinfo", method, undefined, {
        Authorization: "Bearer " + (await bearer()),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        sub: user.id,
        updated_at: 1767312000,
        name: user.name,
        picture: null,
        email: user.email,
        email_verified: true,
      });
    });
    it(`actual ${method} UserInfo returns phone/address only when explicitly scoped`, async (): Promise<void> => {
      const response = await request("/api/userinfo", method, undefined, {
        Authorization: "Bearer " + (await bearer("phone address")),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        sub: user.id,
        updated_at: 1767312000,
        phone_number: user.phone,
        address: { formatted: user.address },
      });
    });
  }
  it("POST body access_token does not replace Bearer header", async (): Promise<void> => {
    const response = await request(
      "/api/userinfo",
      "POST",
      new URLSearchParams({ access_token: await bearer() }).toString(),
      { "Content-Type": "application/x-www-form-urlencoded" },
    );
    expect(response.status).toBe(401);
    expect((await response.json<{ error: { code: string } }>()).error.code).toBe("UNAUTHORIZED");
  });
  it("actual issueTokenPair service audience does not pass current UserInfo audience gate", async (): Promise<void> => {
    const issued = await issueTokenPair(db, env, user, {
      serviceId: service.id,
      clientId,
      scope: "openid profile",
    });
    queries.length = 0;
    const response = await request("/api/userinfo", "GET", undefined, {
      Authorization: "Bearer " + issued.accessToken,
    });
    expect(response.status).toBe(401);
    expect((await response.json<{ error: { code: string } }>()).error.code).toBe("UNAUTHORIZED");
    expect(queries).toEqual([]);
  });
  it("actual common limiter denies with REST 429 and Retry-After 60", async (): Promise<void> => {
    const limited = {
      ...env,
      RATE_LIMITER_EXTERNAL: {
        limit: async (): Promise<{ success: boolean }> => ({ success: false }),
      },
    };
    const response = await request("/api/userinfo", "GET", undefined, {}, limited);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect((await response.json<{ error: { code: string } }>()).error.code).toBe(
      "TOO_MANY_REQUESTS",
    );
    expect(fetchGuard).not.toHaveBeenCalled();
  });
  it("full app exposes known device JSON null/non-string-scope 500 separately from malformed 400", async (): Promise<void> => {
    const cases = [
      ["null", 500, "INTERNAL_ERROR"],
      ["[]", 400, "invalid_request"],
      ['"fixture"', 400, "invalid_request"],
      ["1", 400, "invalid_request"],
      ["true", 400, "invalid_request"],
      ["{", 400, "invalid_request"],
      [JSON.stringify({ client_id: clientId, scope: 1 }), 500, "INTERNAL_ERROR"],
    ] as const;
    for (const [body, status, code] of cases) {
      const response = await fullRequest("/api/device/code", "POST", body, {
        "Content-Type": "application/json",
      });
      expect(response.status).toBe(status);
      const result = await response.json<{ error: string | { code: string } }>();
      expect(typeof result.error === "string" ? result.error : result.error.code).toBe(code);
    }
  });
  it("full app applies REST 413 to all four operations before any DB call", async (): Promise<void> => {
    for (const path of ["/api/token", "/api/device/code", "/api/device/verify", "/api/userinfo"]) {
      queries.length = 0;
      const response = await fullRequest(path, "POST", "x".repeat(64 * 1024 + 1), {
        "Content-Type": "application/json",
      });
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({
        error: { code: "PAYLOAD_TOO_LARGE", message: "Request body too large" },
      });
      expect(queries).toEqual([]);
    }
  });
  it("full app fails closed with REST 503 when public-operation limiters are missing", async (): Promise<void> => {
    for (const [path, binding] of [
      ["/api/token", "RATE_LIMITER_TOKEN"],
      ["/api/device/code", "RATE_LIMITER_TOKEN"],
      ["/api/userinfo", "RATE_LIMITER_EXTERNAL"],
    ] as const) {
      queries.length = 0;
      const response = await fullRequest(
        path,
        "POST",
        "{}",
        { "Content-Type": "application/json" },
        { ...env, [binding]: undefined },
      );
      expect(response.status).toBe(503);
      expect((await response.json<{ error: { code: string } }>()).error.code).toBe(
        "SERVICE_UNAVAILABLE",
      );
      expect(queries).toEqual([]);
    }
  });
  it("full app returns REST 503 for missing device-verification limiter after valid BFF auth", async (): Promise<void> => {
    const response = await fullRequest(
      "/api/device/verify",
      "POST",
      JSON.stringify({ user_code: "abcd-efgh" }),
      { "Content-Type": "application/json", Authorization: "Bearer " + (await bearer()) },
      { ...env, RATE_LIMITER_DEVICE_VERIFY: undefined },
    );
    expect(response.status).toBe(503);
    expect((await response.json<{ error: { code: string } }>()).error.code).toBe(
      "SERVICE_UNAVAILABLE",
    );
  });
  it("actual verification returns 404 for a code absent after cleanup", async (): Promise<void> => {
    deviceVisible = false;
    try {
      const response = await fullRequest(
        "/api/device/verify",
        "POST",
        JSON.stringify({ user_code: "abcd-efgh" }),
        { "Content-Type": "application/json", Authorization: "Bearer " + (await bearer()) },
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: { code: "INVALID_CODE", message: "Unknown or expired user_code" },
      });
    } finally {
      deviceVisible = true;
    }
  });
  it("actual verification distinguishes retained expired code 400 from deleted code 404", async (): Promise<void> => {
    const originalExpires = device.expires_at;
    device.expires_at = "2000-01-01T00:00:00Z";
    try {
      const response = await fullRequest(
        "/api/device/verify",
        "POST",
        JSON.stringify({ user_code: "abcd-efgh" }),
        { "Content-Type": "application/json", Authorization: "Bearer " + (await bearer()) },
      );
      expect(response.status).toBe(400);
      expect((await response.json<{ error: { code: string } }>()).error.code).toBe("CODE_EXPIRED");
    } finally {
      device.expires_at = originalExpires;
    }
  });
  it("actual device start/polling ignore incorrect Basic with valid body client_id", async (): Promise<void> => {
    const authorization = "Basic " + btoa("wrong-client:wrong-secret");
    const start = await fullRequest(
      "/api/device/code",
      "POST",
      JSON.stringify({ client_id: clientId }),
      { "Content-Type": "application/json", Authorization: authorization },
    );
    expect(start.status).toBe(200);
    const response = await fullRequest(
      "/api/token",
      "POST",
      new URLSearchParams({
        grant_type: grant,
        device_code: "synthetic-code",
        client_id: clientId,
      }).toString(),
      { "Content-Type": "application/x-www-form-urlencoded", Authorization: authorization },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "authorization_pending" });
    expect(response.headers.get("WWW-Authenticate")).toBeNull();
  });
  it("real auth-code/device scope resolver defaults null/empty saved values to openid only", (): void => {
    expect(resolveEffectiveScope(null, service.allowed_scopes)).toBe("openid");
    expect(resolveEffectiveScope("", service.allowed_scopes)).toBe("openid");
    expect(resolveEffectiveScope("profile", service.allowed_scopes)).toBe("profile");
  });
});

import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { Hono } from "hono";
import { createMockIdpEnv } from "../../../../packages/shared/src/db/test-helpers";

// --- モック定義（DB アクセスのみ差し替え、暗号系は実物を使う） ---
vi.mock("@0g0-id/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@0g0-id/shared")>();
  return {
    ...actual,
    createLogger: vi
      .fn()
      .mockReturnValue({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    createService: vi.fn(),
    findServiceByClientId: vi.fn(),
    updateDcrClientFields: vi.fn(),
    deleteService: vi.fn(),
    listRedirectUris: vi.fn(),
    addRedirectUri: vi.fn(),
    deleteRedirectUri: vi.fn(),
    revokeAllServiceTokens: vi.fn(),
  };
});

import {
  createService,
  findServiceByClientId,
  updateDcrClientFields,
  deleteService,
  listRedirectUris,
  addRedirectUri,
  deleteRedirectUri,
  revokeAllServiceTokens,
} from "@0g0-id/shared";
import type { Service, ServiceRedirectUri } from "@0g0-id/shared";
import registerRoutes from "./register";

const mockEnv = createMockIdpEnv();

// --- インメモリの疑似ストア ---
let storedService: Service | null;
let storedUris: ServiceRedirectUri[];

function buildApp() {
  const app = new Hono<{ Bindings: typeof mockEnv }>();
  app.route("/api/register", registerRoutes);
  return app;
}

function postRegister(body: Record<string, unknown>) {
  const app = buildApp();
  return app.request(
    new Request("https://id.0g0.xyz/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    undefined,
    mockEnv,
  );
}

function configRequest(method: string, clientId: string, token?: string, body?: unknown) {
  const app = buildApp();
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return app.request(
    new Request(`https://id.0g0.xyz/api/register/${clientId}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
    undefined,
    mockEnv,
  );
}

const validMetadata = {
  client_name: "ChatGPT",
  redirect_uris: ["https://chatgpt.com/connector/oauth/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  token_endpoint_auth_method: "none",
};

beforeEach(() => {
  vi.clearAllMocks();
  storedService = null;
  storedUris = [];

  vi.mocked(createService).mockImplementation(async (_db, params) => {
    storedService = {
      id: params.id,
      name: params.name,
      client_id: params.clientId,
      client_secret_hash: params.clientSecretHash,
      allowed_scopes: params.allowedScopes,
      owner_user_id: params.ownerUserId,
      source: params.source ?? "admin",
      registration_access_token_hash: params.registrationAccessTokenHash ?? null,
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
    };
    return storedService;
  });
  vi.mocked(findServiceByClientId).mockImplementation(async (_db, clientId) =>
    storedService && storedService.client_id === clientId ? storedService : null,
  );
  vi.mocked(listRedirectUris).mockImplementation(async () => storedUris);
  vi.mocked(addRedirectUri).mockImplementation(async (_db, params) => {
    const uri: ServiceRedirectUri = {
      id: params.id,
      service_id: params.serviceId,
      uri: params.uri,
      created_at: "2024-01-01T00:00:00Z",
    };
    storedUris.push(uri);
    return uri;
  });
  vi.mocked(deleteRedirectUri).mockImplementation(async (_db, id) => {
    storedUris = storedUris.filter((u) => u.id !== id);
    return 1;
  });
  vi.mocked(updateDcrClientFields).mockImplementation(async (_db, _id, fields) => {
    if (!storedService) return null;
    if (fields.name !== undefined) storedService.name = fields.name;
    if (fields.allowedScopes !== undefined) storedService.allowed_scopes = fields.allowedScopes;
    return storedService;
  });
  vi.mocked(deleteService).mockImplementation(async () => {
    storedService = null;
    storedUris = [];
  });
  vi.mocked(revokeAllServiceTokens).mockResolvedValue(0);
});

describe("POST /api/register (RFC 7591)", () => {
  it("正常登録 → 201、公開クライアントとして services に保存される", async () => {
    const res = await postRegister(validMetadata);
    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    expect(body.client_id).toBeTruthy();
    expect(body.registration_access_token).toBeTruthy();
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.redirect_uris).toEqual(["https://chatgpt.com/connector/oauth/callback"]);
    expect(body.registration_client_uri).toBe(`https://id.0g0.xyz/api/register/${body.client_id}`);

    expect(createService).toHaveBeenCalledWith(
      mockEnv.DB,
      expect.objectContaining({
        clientSecretHash: "",
        source: "dcr",
        ownerUserId: "system-dcr-owner",
        allowedScopes: '["profile","email"]',
      }),
    );
  });

  it("localhost の http redirect URI は許可される", async () => {
    const res = await postRegister({
      ...validMetadata,
      redirect_uris: ["http://localhost:8080/callback"],
    });
    expect(res.status).toBe(201);
  });

  it("http（非localhost）の redirect URI → 400 invalid_redirect_uri", async () => {
    const res = await postRegister({
      ...validMetadata,
      redirect_uris: ["http://example.com/callback"],
    });
    expect(res.status).toBe(400);
    const body = await res.json<Record<string, unknown>>();
    expect(body.error).toBe("invalid_redirect_uri");
    expect(createService).not.toHaveBeenCalled();
  });

  it("redirect URI が上限件数超 → 400 invalid_redirect_uri", async () => {
    const res = await postRegister({
      ...validMetadata,
      redirect_uris: Array.from({ length: 6 }, (_, i) => `https://example.com/cb${i}`),
    });
    expect(res.status).toBe(400);
    const body = await res.json<Record<string, unknown>>();
    expect(body.error).toBe("invalid_redirect_uri");
  });

  it("対応外スコープの要求 → 400 invalid_client_metadata（過剰スコープ拒否）", async () => {
    const res = await postRegister({ ...validMetadata, scope: "openid events:subscribe" });
    expect(res.status).toBe(400);
    const body = await res.json<Record<string, unknown>>();
    expect(body.error).toBe("invalid_client_metadata");
    expect(createService).not.toHaveBeenCalled();
  });

  it("機密クライアントの登録 → 400 invalid_client_metadata", async () => {
    const res = await postRegister({
      ...validMetadata,
      token_endpoint_auth_method: "client_secret_basic",
    });
    expect(res.status).toBe(400);
    const body = await res.json<Record<string, unknown>>();
    expect(body.error).toBe("invalid_client_metadata");
  });

  it("対応外 grant_types → 400 invalid_client_metadata", async () => {
    const res = await postRegister({ ...validMetadata, grant_types: ["client_credentials"] });
    expect(res.status).toBe(400);
    const body = await res.json<Record<string, unknown>>();
    expect(body.error).toBe("invalid_client_metadata");
  });

  it("scope 指定時は許可範囲で保存される", async () => {
    const res = await postRegister({ ...validMetadata, scope: "openid profile" });
    expect(res.status).toBe(201);
    expect(createService).toHaveBeenCalledWith(
      mockEnv.DB,
      expect.objectContaining({ allowedScopes: '["profile"]' }),
    );
  });
});

describe("RFC 7592 クライアント構成エンドポイント", () => {
  async function registerOne(): Promise<{ clientId: string; registrationToken: string }> {
    const res = await postRegister(validMetadata);
    const body = await res.json<Record<string, unknown>>();
    return {
      clientId: body.client_id as string,
      registrationToken: body.registration_access_token as string,
    };
  }

  it("GET: 正しい registration_access_token で構成を読める", async () => {
    const { clientId, registrationToken } = await registerOne();
    const res = await configRequest("GET", clientId, registrationToken);
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.client_id).toBe(clientId);
    expect(body.client_name).toBe("ChatGPT");
    expect(body.registration_access_token).toBeUndefined();
  });

  it("GET: トークン不一致 → 401", async () => {
    const { clientId } = await registerOne();
    const res = await configRequest("GET", clientId, "wrong-token");
    expect(res.status).toBe(401);
  });

  it("GET: 未登録クライアント → 404", async () => {
    const res = await configRequest("GET", "nonexistent-client", "some-token");
    expect(res.status).toBe(404);
  });

  it("PUT: redirect URI と名前を更新できる", async () => {
    const { clientId, registrationToken } = await registerOne();
    const res = await configRequest("PUT", clientId, registrationToken, {
      client_id: clientId,
      client_name: "Renamed",
      redirect_uris: ["https://example.com/new-callback"],
      token_endpoint_auth_method: "none",
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.client_name).toBe("Renamed");
    expect(body.redirect_uris).toEqual(["https://example.com/new-callback"]);
  });

  it("DELETE: クライアントを削除し、トークンも失効させる", async () => {
    const { clientId, registrationToken } = await registerOne();
    const res = await configRequest("DELETE", clientId, registrationToken);
    expect(res.status).toBe(204);
    expect(revokeAllServiceTokens).toHaveBeenCalled();
    const after = await configRequest("GET", clientId, registrationToken);
    expect(after.status).toBe(404);
  });
});

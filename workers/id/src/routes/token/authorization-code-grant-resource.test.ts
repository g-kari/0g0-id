import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { createMockIdpEnv } from "../../../../../packages/shared/src/db/test-helpers";

// --- モック定義 ---
vi.mock("@0g0-id/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@0g0-id/shared")>();
  return {
    ...actual,
    createLogger: vi
      .fn()
      .mockReturnValue({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    sha256: vi.fn(),
    findAndConsumeAuthCode: vi.fn(),
    findUserById: vi.fn(),
    findResourceServerByUri: vi.fn(),
    generateCodeChallenge: vi.fn(),
    timingSafeEqual: vi.fn(),
    normalizeRedirectUri: vi.fn(),
    matchRedirectUri: vi.fn(),
  };
});

vi.mock("../../utils/scopes", () => ({
  resolveEffectiveScope: vi.fn(),
  resolveResourceScope: vi.fn(),
  isSubjectAllowedForResource: vi.fn(),
}));

vi.mock("../../utils/token-pair", () => ({
  issueTokenPair: vi.fn(),
  buildTokenResponse: vi.fn(),
  issueIdToken: vi.fn(),
}));

vi.mock("./utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./utils")>();
  return {
    ...actual,
    resolveOAuthClient: vi.fn(),
  };
});

import {
  sha256,
  findAndConsumeAuthCode,
  findUserById,
  findResourceServerByUri,
  generateCodeChallenge,
  timingSafeEqual,
  normalizeRedirectUri,
  matchRedirectUri,
} from "@0g0-id/shared";
import { resolveResourceScope, isSubjectAllowedForResource } from "../../utils/scopes";
import { issueTokenPair, buildTokenResponse, issueIdToken } from "../../utils/token-pair";
import { resolveOAuthClient } from "./utils";
import { handleAuthorizationCodeGrant } from "./authorization-code-grant";

import type { TokenHandlerContext } from "./utils";

// --- テスト用定数 ---
const mockEnv = createMockIdpEnv();
const RESOURCE_URI = "https://dots-events.0g0.xyz/mcp";

const mockService = {
  id: "svc-1",
  name: "ChatGPT",
  client_id: "test-client",
  client_secret_hash: "",
  allowed_scopes: '["profile","email"]',
  owner_user_id: "user-1",
  source: "dcr",
  registration_access_token_hash: "hash",
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
};

const mockUser = {
  id: "user-1",
  google_sub: "g-1",
  line_sub: null,
  twitch_sub: null,
  github_sub: null,
  x_sub: null,
  email: "user@example.com",
  email_verified: 1,
  name: "Test User",
  picture: null,
  phone: null,
  address: null,
  role: "user" as const,
  banned_at: null,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
};

const mockResourceServer = {
  id: "rs-1",
  uri: RESOURCE_URI,
  name: "dots-events",
  allowed_scopes: '["events:read","events:subscribe","requests:read","requests:update"]',
  allowed_subjects: "[]",
  owner_user_id: "user-1",
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
};

const mockAuthCode = {
  id: "ac-1",
  user_id: "user-1",
  service_id: "svc-1",
  code_hash: "hashed-code",
  redirect_to: "https://chatgpt.com/connector/oauth/callback",
  scope: "events:read events:subscribe",
  code_challenge: "challenge-value",
  code_challenge_method: "S256",
  nonce: null,
  provider: "google",
  resource: RESOURCE_URI,
  used_at: null,
  expires_at: "2099-01-01T00:00:00Z",
  created_at: "2024-01-01T00:00:00Z",
};

function createMockContext(): TokenHandlerContext {
  const responseHeaders: Record<string, string> = {};
  return {
    env: mockEnv,
    req: { header: () => undefined },
    header: (name: string, value: string) => {
      responseHeaders[name] = value;
    },
    json: (data: unknown, status?: number) => {
      return Response.json(data, { status: status ?? 200, headers: responseHeaders });
    },
  };
}

const baseParams: Record<string, string> = {
  code: "the-code",
  redirect_uri: "https://chatgpt.com/connector/oauth/callback",
  client_id: "test-client",
  code_verifier: "verifier-value-that-is-long-enough-for-pkce-43chars",
};

describe("handleAuthorizationCodeGrant (RFC 8707 resource)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sha256).mockResolvedValue("hashed-code");
    vi.mocked(normalizeRedirectUri).mockReturnValue("https://chatgpt.com/connector/oauth/callback");
    vi.mocked(matchRedirectUri).mockReturnValue(true);
    vi.mocked(resolveOAuthClient).mockResolvedValue({
      ok: true,
      service: mockService,
      isPublicClient: true,
    });
    vi.mocked(findAndConsumeAuthCode).mockResolvedValue(mockAuthCode);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(generateCodeChallenge).mockResolvedValue("challenge-value");
    vi.mocked(timingSafeEqual).mockReturnValue(true);
    vi.mocked(findResourceServerByUri).mockResolvedValue(mockResourceServer);
    vi.mocked(isSubjectAllowedForResource).mockReturnValue(true);
    vi.mocked(resolveResourceScope).mockReturnValue("events:read events:subscribe");
    vi.mocked(issueTokenPair).mockResolvedValue({
      accessToken: "access-token",
      refreshToken: "refresh-token",
    });
    vi.mocked(issueIdToken).mockResolvedValue(undefined);
    vi.mocked(buildTokenResponse).mockImplementation(
      (accessToken: string, refreshToken: string, scope?: string) => ({
        access_token: accessToken,
        refresh_token: refreshToken,
        scope,
      }),
    );
  });

  it("resource 束縛コード → aud 束縛つきでトークンを発行する", async () => {
    const res = await handleAuthorizationCodeGrant(createMockContext(), {
      ...baseParams,
      resource: RESOURCE_URI,
    });
    expect(res.status).toBe(200);
    expect(issueTokenPair).toHaveBeenCalledWith(
      mockEnv.DB,
      mockEnv,
      mockUser,
      expect.objectContaining({
        serviceId: "svc-1",
        clientId: "test-client",
        scope: "events:read events:subscribe",
        resource: RESOURCE_URI,
      }),
    );
    const body = await res.json<Record<string, unknown>>();
    expect(body.access_token).toBe("access-token");
  });

  it("トークンリクエストの resource がコードと不一致 → 400 invalid_grant", async () => {
    const res = await handleAuthorizationCodeGrant(createMockContext(), {
      ...baseParams,
      resource: "https://other.example/mcp",
    });
    expect(res.status).toBe(400);
    const body = await res.json<Record<string, unknown>>();
    expect(body.error).toBe("invalid_grant");
    expect(issueTokenPair).not.toHaveBeenCalled();
  });

  it("リソースサーバーが削除済み → 400 invalid_grant", async () => {
    vi.mocked(findResourceServerByUri).mockResolvedValue(null);
    const res = await handleAuthorizationCodeGrant(createMockContext(), {
      ...baseParams,
      resource: RESOURCE_URI,
    });
    expect(res.status).toBe(400);
    const body = await res.json<Record<string, unknown>>();
    expect(body.error).toBe("invalid_grant");
    expect(issueTokenPair).not.toHaveBeenCalled();
  });

  it("有効スコープが残らない → 400 invalid_scope", async () => {
    vi.mocked(resolveResourceScope).mockReturnValue(undefined);
    const res = await handleAuthorizationCodeGrant(createMockContext(), {
      ...baseParams,
      resource: RESOURCE_URI,
    });
    expect(res.status).toBe(400);
    const body = await res.json<Record<string, unknown>>();
    expect(body.error).toBe("invalid_scope");
    expect(issueTokenPair).not.toHaveBeenCalled();
  });

  it("利用者制限で許可されていない subject → 400 invalid_grant（発行しない）", async () => {
    vi.mocked(findResourceServerByUri).mockResolvedValue({
      ...mockResourceServer,
      allowed_subjects: '["someone-else"]',
    });
    vi.mocked(isSubjectAllowedForResource).mockReturnValue(false);
    const res = await handleAuthorizationCodeGrant(createMockContext(), {
      ...baseParams,
      resource: RESOURCE_URI,
    });
    expect(res.status).toBe(400);
    const body = await res.json<Record<string, unknown>>();
    expect(body.error).toBe("invalid_grant");
    expect(body.error_description).toContain("subject is not allowed");
    expect(isSubjectAllowedForResource).toHaveBeenCalledWith(
      expect.objectContaining({ allowed_subjects: '["someone-else"]' }),
      "user-1",
    );
    expect(issueTokenPair).not.toHaveBeenCalled();
  });

  it("利用者制限で許可された subject → 通常どおり発行する", async () => {
    vi.mocked(findResourceServerByUri).mockResolvedValue({
      ...mockResourceServer,
      allowed_subjects: '["user-1"]',
    });
    vi.mocked(isSubjectAllowedForResource).mockReturnValue(true);
    const res = await handleAuthorizationCodeGrant(createMockContext(), {
      ...baseParams,
      resource: RESOURCE_URI,
    });
    expect(res.status).toBe(200);
    expect(issueTokenPair).toHaveBeenCalled();
  });
});

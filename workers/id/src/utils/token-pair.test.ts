import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

vi.mock("@0g0-id/shared", () => ({
  generateToken: vi.fn(),
  sha256: vi.fn(),
  generatePairwiseSub: vi.fn(),
  signAccessToken: vi.fn(),
  createRefreshToken: vi.fn(),
}));

import {
  generateToken,
  sha256,
  generatePairwiseSub,
  signAccessToken,
  createRefreshToken,
} from "@0g0-id/shared";
import type { IdpEnv, User } from "@0g0-id/shared";
import {
  issueTokenPair,
  buildTokenResponse,
  REFRESH_TOKEN_TTL_MS,
  ACCESS_TOKEN_TTL_SECONDS,
} from "./token-pair";

const mockDb = {} as D1Database;

const mockEnv: IdpEnv = {
  IDP_ORIGIN: "https://id.example.com",
  JWT_PRIVATE_KEY: "mock-private-key",
  JWT_PUBLIC_KEY: "mock-public-key",
} as unknown as IdpEnv;

const mockUser: User = {
  id: "user-123",
  email: "user@example.com",
  role: "user",
} as User;

describe("issueTokenPair", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(signAccessToken).mockResolvedValue("mock-access-token");
    vi.mocked(generateToken).mockReturnValue("mock-refresh-token");
    vi.mocked(sha256).mockResolvedValue("mock-hash");
    vi.mocked(createRefreshToken).mockResolvedValue(undefined);
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "mock-uuid-1234" as ReturnType<typeof crypto.randomUUID>,
    );
  });

  it("accessToken と refreshToken を返す", async () => {
    const result = await issueTokenPair(mockDb, mockEnv, mockUser, { serviceId: "service-1" });

    expect(result.accessToken).toBe("mock-access-token");
    expect(result.refreshToken).toBe("mock-refresh-token");
  });

  it("signAccessToken に正しいペイロードを渡す（serviceId なし・scope なし）", async () => {
    await issueTokenPair(mockDb, mockEnv, mockUser, { serviceId: null });

    expect(signAccessToken).toHaveBeenCalledWith(
      {
        iss: "https://id.example.com",
        sub: "user-123",
        aud: "https://id.example.com",
        email: "user@example.com",
        role: "user",
        scope: undefined,
        cid: undefined,
      },
      "mock-private-key",
      "mock-public-key",
    );
  });

  it("clientId が指定された場合は cid に含める", async () => {
    await issueTokenPair(mockDb, mockEnv, mockUser, {
      serviceId: "service-1",
      clientId: "client-abc",
    });

    expect(signAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ cid: "client-abc", aud: "client-abc" }),
      expect.any(String),
      expect.any(String),
    );
  });

  it("clientId が指定された場合、aud に clientId がセットされる", async () => {
    await issueTokenPair(mockDb, mockEnv, mockUser, {
      serviceId: "service-1",
      clientId: "client-abc",
    });

    expect(signAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ aud: "client-abc" }),
      expect.any(String),
      expect.any(String),
    );
  });

  it("scope が指定された場合は signAccessToken に渡す", async () => {
    await issueTokenPair(mockDb, mockEnv, mockUser, {
      serviceId: "service-1",
      scope: "openid profile",
    });

    expect(signAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "openid profile" }),
      expect.any(String),
      expect.any(String),
    );
  });

  it("clientId がある場合は pairwiseSub を generatePairwiseSub(clientId, userId) で生成する", async () => {
    vi.mocked(sha256).mockResolvedValueOnce("refresh-token-hash");
    vi.mocked(generatePairwiseSub).mockResolvedValueOnce("pairwise-sub-hash");

    await issueTokenPair(mockDb, mockEnv, mockUser, {
      serviceId: "service-1",
      clientId: "client-abc",
    });

    expect(generatePairwiseSub).toHaveBeenCalledWith("client-abc", "user-123", undefined);
    expect(createRefreshToken).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ pairwiseSub: "pairwise-sub-hash" }),
    );
  });

  it("clientId がない場合は pairwiseSub が null になる", async () => {
    await issueTokenPair(mockDb, mockEnv, mockUser, { serviceId: "service-1" });

    expect(createRefreshToken).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ pairwiseSub: null }),
    );
  });

  it("familyId が指定されていない場合は crypto.randomUUID() で生成する", async () => {
    await issueTokenPair(mockDb, mockEnv, mockUser, { serviceId: "service-1" });

    expect(createRefreshToken).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ familyId: "mock-uuid-1234" }),
    );
  });

  it("familyId が指定された場合はそれを使う", async () => {
    await issueTokenPair(mockDb, mockEnv, mockUser, {
      serviceId: "service-1",
      familyId: "existing-family",
    });

    expect(createRefreshToken).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ familyId: "existing-family" }),
    );
  });

  it("serviceId: null を createRefreshToken に渡す", async () => {
    await issueTokenPair(mockDb, mockEnv, mockUser, { serviceId: null });

    expect(createRefreshToken).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ serviceId: null }),
    );
  });

  it("scope が未指定の場合 createRefreshToken に scope: null を渡す", async () => {
    await issueTokenPair(mockDb, mockEnv, mockUser, { serviceId: "service-1" });

    expect(createRefreshToken).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ scope: null }),
    );
  });

  it("scope が指定された場合 createRefreshToken にそれを渡す", async () => {
    await issueTokenPair(mockDb, mockEnv, mockUser, {
      serviceId: "service-1",
      scope: "openid email",
    });

    expect(createRefreshToken).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ scope: "openid email" }),
    );
  });

  it("expiresAt が REFRESH_TOKEN_TTL_MS 後の ISO 文字列になる", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);

    await issueTokenPair(mockDb, mockEnv, mockUser, { serviceId: "service-1" });

    const expectedExpiresAt = new Date(now + REFRESH_TOKEN_TTL_MS).toISOString();
    expect(createRefreshToken).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ expiresAt: expectedExpiresAt }),
    );
  });

  it("リフレッシュトークンの sha256 ハッシュを tokenHash として渡す", async () => {
    vi.mocked(generateToken).mockReturnValue("plain-refresh-token");
    vi.mocked(sha256).mockResolvedValue("hashed-refresh-token");

    await issueTokenPair(mockDb, mockEnv, mockUser, { serviceId: "service-1" });

    expect(sha256).toHaveBeenCalledWith("plain-refresh-token");
    expect(createRefreshToken).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ tokenHash: "hashed-refresh-token" }),
    );
  });
});

describe("buildTokenResponse", () => {
  it("基本レスポンス（idToken・scope なし）", () => {
    const result = buildTokenResponse("access-token", "refresh-token");

    expect(result).toEqual({
      access_token: "access-token",
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: "refresh-token",
    });
  });

  it("idToken がある場合は id_token を含める", () => {
    const result = buildTokenResponse("access-token", "refresh-token", undefined, "id-token");

    expect(result).toHaveProperty("id_token", "id-token");
  });

  it("scope がある場合は scope を含める", () => {
    const result = buildTokenResponse("access-token", "refresh-token", "openid profile");

    expect(result).toHaveProperty("scope", "openid profile");
  });

  it("idToken・scope 両方ある場合は両方含める", () => {
    const result = buildTokenResponse("access-token", "refresh-token", "openid", "id-token");

    expect(result).toMatchObject({
      access_token: "access-token",
      refresh_token: "refresh-token",
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      scope: "openid",
      id_token: "id-token",
    });
  });

  it("idToken が undefined の場合は id_token を含めない", () => {
    const result = buildTokenResponse("access-token", "refresh-token", "openid", undefined);

    expect(result).not.toHaveProperty("id_token");
  });

  it("scope が undefined の場合は scope を含めない", () => {
    const result = buildTokenResponse("access-token", "refresh-token", undefined);

    expect(result).not.toHaveProperty("scope");
  });

  it("expires_in は ACCESS_TOKEN_TTL_SECONDS（900秒）", () => {
    const result = buildTokenResponse("access-token", "refresh-token");

    expect(result.expires_in).toBe(900);
  });
});

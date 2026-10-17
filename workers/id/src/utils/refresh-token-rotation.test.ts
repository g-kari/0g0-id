import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

vi.mock("@0g0-id/shared", () => ({
  findAndRevokeRefreshToken: vi.fn(),
  findRefreshTokenByHash: vi.fn(),
  revokeTokenFamily: vi.fn(),
}));

vi.mock("./token-pair", () => ({
  issueTokenPair: vi.fn(),
}));

vi.mock("./token-recovery", () => ({
  attemptUnrevokeToken: vi.fn(),
}));

import {
  findAndRevokeRefreshToken,
  findRefreshTokenByHash,
  revokeTokenFamily,
} from "@0g0-id/shared";
import { issueTokenPair } from "./token-pair";
import { attemptUnrevokeToken } from "./token-recovery";
import {
  validateAndRevokeRefreshToken,
  issueTokenPairWithRecovery,
} from "./refresh-token-rotation";
import type { RefreshToken, User, IdpEnv } from "@0g0-id/shared";

const mockDb = {} as D1Database;

function makeToken(overrides: Partial<RefreshToken> = {}): RefreshToken {
  return {
    id: "token-1",
    user_id: "user-1",
    service_id: "service-1",
    token_hash: "hash-abc",
    family_id: "family-1",
    revoked_at: null,
    revoked_reason: null,
    scope: "openid profile",
    pairwise_sub: null,
    expires_at: "2026-05-01T00:00:00Z",
    created_at: "2026-04-01T00:00:00Z",
    ...overrides,
  };
}

// ===== validateAndRevokeRefreshToken =====
describe("validateAndRevokeRefreshToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("findAndRevokeRefreshToken が storedToken を返す場合は { ok: true, storedToken } を返す", async () => {
    const stored = makeToken();
    vi.mocked(findAndRevokeRefreshToken).mockResolvedValue(stored);
    const result = await validateAndRevokeRefreshToken(mockDb, "hash-abc");
    expect(result).toEqual({ ok: true, storedToken: stored });
    expect(findRefreshTokenByHash).not.toHaveBeenCalled();
  });

  it("未存在トークンの場合は { ok: false, reason: INVALID_TOKEN } を返す", async () => {
    vi.mocked(findAndRevokeRefreshToken).mockResolvedValue(null);
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(null);
    const result = await validateAndRevokeRefreshToken(mockDb, "hash-abc");
    expect(result).toEqual({ ok: false, reason: "INVALID_TOKEN" });
    expect(revokeTokenFamily).not.toHaveBeenCalled();
  });

  it("rotation で失効 + 30秒以内の場合は { ok: false, reason: TOKEN_ROTATED } を返す", async () => {
    vi.mocked(findAndRevokeRefreshToken).mockResolvedValue(null);
    const revokedAt = new Date(Date.now() - 10_000).toISOString(); // 10秒前
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(
      makeToken({ revoked_reason: "rotation", revoked_at: revokedAt }),
    );
    const result = await validateAndRevokeRefreshToken(mockDb, "hash-abc");
    expect(result).toEqual({ ok: false, reason: "TOKEN_ROTATED" });
    expect(revokeTokenFamily).not.toHaveBeenCalled();
  });

  it("rotation で失効 + 30秒超の場合はファミリー全失効して { ok: false, reason: TOKEN_REUSE } を返す", async () => {
    vi.mocked(findAndRevokeRefreshToken).mockResolvedValue(null);
    const revokedAt = new Date(Date.now() - 60_000).toISOString(); // 60秒前
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(
      makeToken({ revoked_reason: "rotation", revoked_at: revokedAt, family_id: "family-1" }),
    );
    vi.mocked(revokeTokenFamily).mockResolvedValue(undefined);
    const result = await validateAndRevokeRefreshToken(mockDb, "hash-abc");
    expect(result).toEqual({ ok: false, reason: "TOKEN_REUSE" });
    expect(revokeTokenFamily).toHaveBeenCalledWith(mockDb, "family-1", "reuse_detected");
  });

  it("rotation 以外の理由（logout 等）で失効している場合は INVALID_TOKEN を返す", async () => {
    vi.mocked(findAndRevokeRefreshToken).mockResolvedValue(null);
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(
      makeToken({ revoked_reason: "logout", revoked_at: new Date().toISOString() }),
    );
    const result = await validateAndRevokeRefreshToken(mockDb, "hash-abc");
    expect(result).toEqual({ ok: false, reason: "INVALID_TOKEN" });
    expect(revokeTokenFamily).not.toHaveBeenCalled();
  });

  it("30秒境界値: revoked_at がちょうど30秒前の場合は TOKEN_REUSE になる（strict less than）", async () => {
    vi.mocked(findAndRevokeRefreshToken).mockResolvedValue(null);
    const revokedAt = new Date(Date.now() - 30_000).toISOString(); // ちょうど30秒前
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(
      makeToken({ revoked_reason: "rotation", revoked_at: revokedAt, family_id: "family-1" }),
    );
    vi.mocked(revokeTokenFamily).mockResolvedValue(undefined);
    const result = await validateAndRevokeRefreshToken(mockDb, "hash-abc");
    expect(result).toEqual({ ok: false, reason: "TOKEN_REUSE" });
    expect(revokeTokenFamily).toHaveBeenCalledWith(mockDb, "family-1", "reuse_detected");
  });

  it("revoked_at が null の rotation トークンは revokedMs=0 となり TOKEN_REUSE になる", async () => {
    vi.mocked(findAndRevokeRefreshToken).mockResolvedValue(null);
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(
      makeToken({ revoked_reason: "rotation", revoked_at: null, family_id: "family-1" }),
    );
    vi.mocked(revokeTokenFamily).mockResolvedValue(undefined);
    const result = await validateAndRevokeRefreshToken(mockDb, "hash-abc");
    expect(result).toEqual({ ok: false, reason: "TOKEN_REUSE" });
    expect(revokeTokenFamily).toHaveBeenCalledWith(mockDb, "family-1", "reuse_detected");
  });

  it("findAndRevokeRefreshToken が例外を投げた場合はそのまま伝播する", async () => {
    vi.mocked(findAndRevokeRefreshToken).mockRejectedValue(new Error("DB connection failed"));
    await expect(validateAndRevokeRefreshToken(mockDb, "hash-abc")).rejects.toThrow(
      "DB connection failed",
    );
  });

  it("findRefreshTokenByHash が例外を投げた場合はそのまま伝播する", async () => {
    vi.mocked(findAndRevokeRefreshToken).mockResolvedValue(null);
    vi.mocked(findRefreshTokenByHash).mockRejectedValue(new Error("DB read error"));
    await expect(validateAndRevokeRefreshToken(mockDb, "hash-abc")).rejects.toThrow(
      "DB read error",
    );
  });

  it("revokeTokenFamily が例外を投げた場合はそのまま伝播する", async () => {
    vi.mocked(findAndRevokeRefreshToken).mockResolvedValue(null);
    const revokedAt = new Date(Date.now() - 60_000).toISOString();
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(
      makeToken({ revoked_reason: "rotation", revoked_at: revokedAt, family_id: "family-1" }),
    );
    vi.mocked(revokeTokenFamily).mockRejectedValue(new Error("DB write error"));
    await expect(validateAndRevokeRefreshToken(mockDb, "hash-abc")).rejects.toThrow(
      "DB write error",
    );
  });
});

// ===== issueTokenPairWithRecovery =====
describe("issueTokenPairWithRecovery", () => {
  const mockUser: User = {
    id: "user-1",
    google_sub: null,
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
    role: "user",
    banned_at: null,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  };

  const mockEnv = {} as IdpEnv;
  const mockLogger = { error: vi.fn() };
  const issueParams = { serviceId: "service-1", clientId: "client-1" };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("issueTokenPair 成功時は { ok: true, accessToken, refreshToken } を返す", async () => {
    vi.mocked(issueTokenPair).mockResolvedValue({ accessToken: "at-xxx", refreshToken: "rt-xxx" });
    const result = await issueTokenPairWithRecovery(
      mockDb,
      mockEnv,
      mockUser,
      issueParams,
      "stored-id",
      "hash-abc",
      mockLogger,
      "test-ctx",
    );
    expect(result).toEqual({ ok: true, accessToken: "at-xxx", refreshToken: "rt-xxx" });
    expect(attemptUnrevokeToken).not.toHaveBeenCalled();
  });

  it("issueTokenPair 失敗 + reuse_detected の場合は { ok: false, reason: TOKEN_REUSE } を返す", async () => {
    vi.mocked(issueTokenPair).mockRejectedValue(new Error("DB error"));
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(
      makeToken({ revoked_reason: "reuse_detected" }),
    );
    const result = await issueTokenPairWithRecovery(
      mockDb,
      mockEnv,
      mockUser,
      issueParams,
      "stored-id",
      "hash-abc",
      mockLogger,
      "test-ctx",
    );
    expect(result).toEqual({ ok: false, reason: "TOKEN_REUSE" });
    expect(attemptUnrevokeToken).not.toHaveBeenCalled();
  });

  it("issueTokenPair 失敗 + reuse_detected 以外の場合は attemptUnrevokeToken を呼んで INTERNAL_ERROR を返す", async () => {
    vi.mocked(issueTokenPair).mockRejectedValue(new Error("DB error"));
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(makeToken({ revoked_reason: "rotation" }));
    vi.mocked(attemptUnrevokeToken).mockResolvedValue(undefined);
    const result = await issueTokenPairWithRecovery(
      mockDb,
      mockEnv,
      mockUser,
      issueParams,
      "stored-id",
      "hash-abc",
      mockLogger,
      "test-ctx",
    );
    expect(result).toEqual({ ok: false, reason: "INTERNAL_ERROR" });
    expect(attemptUnrevokeToken).toHaveBeenCalledWith(
      mockDb,
      "stored-id",
      expect.stringContaining("test-ctx"),
    );
  });

  it("issueTokenPair 失敗 + findRefreshTokenByHash が null の場合も INTERNAL_ERROR を返す", async () => {
    vi.mocked(issueTokenPair).mockRejectedValue(new Error("DB error"));
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(null);
    vi.mocked(attemptUnrevokeToken).mockResolvedValue(undefined);
    const result = await issueTokenPairWithRecovery(
      mockDb,
      mockEnv,
      mockUser,
      issueParams,
      "stored-id",
      "hash-abc",
      mockLogger,
      "test-ctx",
    );
    expect(result).toEqual({ ok: false, reason: "INTERNAL_ERROR" });
    expect(attemptUnrevokeToken).toHaveBeenCalledWith(
      mockDb,
      "stored-id",
      expect.stringContaining("test-ctx"),
    );
  });

  it("attemptUnrevokeToken が例外を投げた場合はそのまま伝播する（catch内のawait）", async () => {
    vi.mocked(issueTokenPair).mockRejectedValue(new Error("DB error"));
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(makeToken({ revoked_reason: "rotation" }));
    vi.mocked(attemptUnrevokeToken).mockRejectedValue(new Error("unrevoke failed"));
    await expect(
      issueTokenPairWithRecovery(
        mockDb,
        mockEnv,
        mockUser,
        issueParams,
        "stored-id",
        "hash-abc",
        mockLogger,
        "test-ctx",
      ),
    ).rejects.toThrow("unrevoke failed");
  });

  it("issueTokenPair 失敗時に logger.error が適切な引数で呼ばれる", async () => {
    const dbError = new Error("DB error");
    vi.mocked(issueTokenPair).mockRejectedValue(dbError);
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(null);
    vi.mocked(attemptUnrevokeToken).mockResolvedValue(undefined);
    await issueTokenPairWithRecovery(
      mockDb,
      mockEnv,
      mockUser,
      issueParams,
      "stored-id",
      "hash-abc",
      mockLogger,
      "test-ctx",
    );
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenCalledWith("test-ctx: issueTokenPair failed", dbError);
  });
});

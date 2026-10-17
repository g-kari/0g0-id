import { describe, it, expect, vi } from "vite-plus/test";
import {
  findRefreshTokenByHash,
  findRefreshTokenById,
  findAndRevokeRefreshToken,
  unrevokeRefreshToken,
  deleteExpiredRefreshTokens,
  findUserIdByPairwiseSub,
  revokeTokenByIdForUser,
  createRefreshToken,
  revokeRefreshToken,
  revokeTokenFamily,
  revokeUserTokens,
  listUserConnections,
  countActiveRefreshTokens,
  hasUserAuthorizedService,
  listUsersAuthorizedForService,
  countUsersAuthorizedForService,
  revokeUserServiceTokens,
  revokeAllServiceTokens,
  listActiveSessionsByUserId,
  revokeOtherUserTokens,
  getServiceTokenStats,
} from "./refresh-tokens";
import type { ServiceTokenStat } from "./refresh-tokens";
import type { RefreshToken, User } from "../types";
import { makeD1Mock } from "./test-helpers";

const baseToken: RefreshToken = {
  id: "token-id-1",
  user_id: "user-1",
  service_id: "service-1",
  token_hash: "hash-abc",
  family_id: "family-1",
  revoked_at: null,
  revoked_reason: null,
  scope: null,
  pairwise_sub: null,
  expires_at: "2025-12-31T23:59:59Z",
  created_at: "2024-01-01T00:00:00Z",
};

const baseUser: User = {
  id: "user-1",
  google_sub: "g-sub",
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

describe("findRefreshTokenByHash", () => {
  it("存在するhashに対してRefreshTokenを返す", async () => {
    const db = makeD1Mock(baseToken);
    const result = await findRefreshTokenByHash(db, "hash-abc");
    expect(result).not.toBeNull();
    expect(result?.id).toBe("token-id-1");
    expect(result?.user_id).toBe("user-1");
    expect(result?.family_id).toBe("family-1");
  });

  it("存在しないhashにはnullを返す", async () => {
    const db = makeD1Mock(null);
    const result = await findRefreshTokenByHash(db, "no-such-hash");
    expect(result).toBeNull();
  });

  it("token_hashでbindを呼ぶ", async () => {
    const db = makeD1Mock(baseToken);
    await findRefreshTokenByHash(db, "hash-abc");
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith("hash-abc");
  });
});

describe("createRefreshToken", () => {
  it("正しいパラメーターでINSERT文を実行する", async () => {
    const db = makeD1Mock();
    await createRefreshToken(db, {
      id: "token-id-1",
      userId: "user-1",
      serviceId: "service-1",
      tokenHash: "hash-abc",
      familyId: "family-1",
      expiresAt: "2025-12-31T23:59:59Z",
    });

    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO refresh_tokens"));
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith(
      "token-id-1",
      "user-1",
      "service-1",
      "hash-abc",
      "family-1",
      "2025-12-31T23:59:59Z",
      null,
      null,
    );
    expect(stmt.run).toHaveBeenCalled();
  });

  it("serviceId が null でも正常に動作する", async () => {
    const db = makeD1Mock();
    await createRefreshToken(db, {
      id: "token-id-2",
      userId: "user-1",
      serviceId: null,
      tokenHash: "hash-xyz",
      familyId: "family-2",
      expiresAt: "2025-12-31T23:59:59Z",
    });
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith(
      "token-id-2",
      "user-1",
      null,
      "hash-xyz",
      "family-2",
      "2025-12-31T23:59:59Z",
      null,
      null,
    );
  });
});

describe("revokeRefreshToken", () => {
  it("指定したidでrevoked_atを更新する", async () => {
    const db = makeD1Mock();
    await revokeRefreshToken(db, "token-id-1");

    const sql: string = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sql).toContain("revoked_at");
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith(null, "token-id-1");
  });

  it("reasonを指定した場合はrevoked_reasonに記録する", async () => {
    const db = makeD1Mock();
    await revokeRefreshToken(db, "token-id-1", "user_logout");

    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith("user_logout", "token-id-1");
  });
});

describe("revokeTokenFamily", () => {
  it("指定したfamilyIdのトークンを全て失効させる", async () => {
    const db = makeD1Mock();
    await revokeTokenFamily(db, "family-1");

    const sql: string = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sql).toContain("family_id");
    expect(sql).toContain("revoked_at");
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith(null, "family-1");
  });

  it("既に失効済みのトークンは対象外（revoked_at IS NULL条件）", async () => {
    const db = makeD1Mock();
    await revokeTokenFamily(db, "family-1");
    const sql: string = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sql).toContain("revoked_at IS NULL");
  });

  it("reasonを指定した場合はrevoked_reasonに記録する", async () => {
    const db = makeD1Mock();
    await revokeTokenFamily(db, "family-1", "reuse_detected");

    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith("reuse_detected", "family-1");
  });
});

describe("revokeUserTokens", () => {
  it("指定したuserIdのトークンを全て失効させる", async () => {
    const db = makeD1Mock();
    await revokeUserTokens(db, "user-1");

    const sql: string = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sql).toContain("user_id");
    expect(sql).toContain("revoked_at");
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith(null, "user-1");
  });

  it("reasonを指定した場合はrevoked_reasonに記録する", async () => {
    const db = makeD1Mock();
    await revokeUserTokens(db, "user-1", "user_logout_all");

    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith("user_logout_all", "user-1");
  });
});

describe("listUserConnections", () => {
  it("ユーザーのアクティブ接続一覧を返す", async () => {
    const mockConnections = [
      {
        service_id: "service-1",
        service_name: "My App",
        client_id: "client-abc",
        pairwise_sub: "pairwise-sub-abc",
        first_authorized_at: "2024-01-01T00:00:00Z",
        last_authorized_at: "2024-06-01T00:00:00Z",
      },
    ];
    const db = makeD1Mock(null, mockConnections);
    const result = await listUserConnections(db, "user-1");
    expect(result).toHaveLength(1);
    expect(result[0].service_name).toBe("My App");
    expect(result[0].client_id).toBe("client-abc");
  });

  it("接続がない場合は空配列を返す", async () => {
    const db = makeD1Mock(null, []);
    const result = await listUserConnections(db, "user-1");
    expect(result).toEqual([]);
  });
});

describe("countActiveRefreshTokens", () => {
  it("アクティブなリフレッシュトークン数を返す", async () => {
    const db = makeD1Mock({ count: 42 });
    const result = await countActiveRefreshTokens(db);
    expect(result).toBe(42);
  });

  it("トークンがない場合は0を返す", async () => {
    const db = makeD1Mock(null);
    const result = await countActiveRefreshTokens(db);
    expect(result).toBe(0);
  });
});

describe("hasUserAuthorizedService", () => {
  it("認可済みの場合はtrueを返す", async () => {
    const db = makeD1Mock({ 1: 1 });
    const result = await hasUserAuthorizedService(db, "user-1", "service-1");
    expect(result).toBe(true);
  });

  it("未認可の場合はfalseを返す", async () => {
    const db = makeD1Mock(null);
    const result = await hasUserAuthorizedService(db, "user-1", "service-1");
    expect(result).toBe(false);
  });
});

describe("listUsersAuthorizedForService", () => {
  it("サービスに認可済みのユーザー一覧を返す", async () => {
    const db = makeD1Mock(null, [baseUser]);
    const result = await listUsersAuthorizedForService(db, "service-1");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("user-1");
  });

  it("デフォルトlimit=50・offset=0でbindする", async () => {
    const db = makeD1Mock(null, []);
    await listUsersAuthorizedForService(db, "service-1");
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith("service-1", 50, 0);
  });

  it("limit・offsetを指定できる", async () => {
    const db = makeD1Mock(null, []);
    await listUsersAuthorizedForService(db, "service-1", 10, 20);
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith("service-1", 10, 20);
  });
});

describe("countUsersAuthorizedForService", () => {
  it("サービスに認可済みのユーザー数を返す", async () => {
    const db = makeD1Mock({ count: 5 });
    const result = await countUsersAuthorizedForService(db, "service-1");
    expect(result).toBe(5);
  });

  it("ユーザーがいない場合は0を返す", async () => {
    const db = makeD1Mock(null);
    const result = await countUsersAuthorizedForService(db, "service-1");
    expect(result).toBe(0);
  });
});

describe("revokeUserServiceTokens", () => {
  it("失効したトークン数を返す", async () => {
    const db = makeD1Mock(null, [], 3);
    const result = await revokeUserServiceTokens(db, "user-1", "service-1");
    expect(result).toBe(3);
  });

  it("対象がない場合は0を返す", async () => {
    const db = makeD1Mock(null, [], 0);
    const result = await revokeUserServiceTokens(db, "user-1", "service-1");
    expect(result).toBe(0);
  });

  it("userId・serviceIdでbindを呼ぶ", async () => {
    const db = makeD1Mock(null, [], 1);
    await revokeUserServiceTokens(db, "user-1", "service-1");
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith(null, "user-1", "service-1");
  });

  it("reasonを指定した場合はrevoked_reasonに記録する", async () => {
    const db = makeD1Mock(null, [], 1);
    await revokeUserServiceTokens(db, "user-1", "service-1", "user_logout");
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith("user_logout", "user-1", "service-1");
  });
});

describe("listActiveSessionsByUserId", () => {
  it("アクティブセッション一覧を返す", async () => {
    const mockSessions = [
      {
        id: "token-id-1",
        service_id: null,
        service_name: null,
        created_at: "2024-01-01T00:00:00Z",
        expires_at: "2025-12-31T23:59:59Z",
      },
      {
        id: "token-id-2",
        service_id: "service-1",
        service_name: "My App",
        created_at: "2024-06-01T00:00:00Z",
        expires_at: "2025-12-31T23:59:59Z",
      },
    ];
    const db = makeD1Mock(null, mockSessions);
    const result = await listActiveSessionsByUserId(db, "user-1");
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("token-id-1");
    expect(result[0].service_id).toBeNull();
    expect(result[1].service_name).toBe("My App");
  });

  it("アクティブセッションがない場合は空配列を返す", async () => {
    const db = makeD1Mock(null, []);
    const result = await listActiveSessionsByUserId(db, "user-1");
    expect(result).toEqual([]);
  });

  it("userIdでbindを呼ぶ", async () => {
    const db = makeD1Mock(null, []);
    await listActiveSessionsByUserId(db, "user-1");
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith("user-1");
  });

  it("SQLにLEFT JOINとservice_nameが含まれる", async () => {
    const db = makeD1Mock(null, []);
    await listActiveSessionsByUserId(db, "user-1");
    const sql: string = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sql).toContain("LEFT JOIN services");
    expect(sql).toContain("service_name");
    expect(sql).toContain("revoked_at IS NULL");
  });
});

describe("revokeOtherUserTokens", () => {
  it("指定hash以外のトークンを全て失効させ、失効数を返す", async () => {
    const db = makeD1Mock(null, [], 2);
    const result = await revokeOtherUserTokens(db, "user-1", "current-hash");
    expect(result).toBe(2);
  });

  it("対象がない場合は0を返す", async () => {
    const db = makeD1Mock(null, [], 0);
    const result = await revokeOtherUserTokens(db, "user-1", "current-hash");
    expect(result).toBe(0);
  });

  it("userId・excludeTokenHashでbindを呼ぶ", async () => {
    const db = makeD1Mock(null, [], 1);
    await revokeOtherUserTokens(db, "user-1", "current-hash");
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith(null, "user-1", "current-hash");
  });

  it("reasonを指定した場合はrevoked_reasonに記録する", async () => {
    const db = makeD1Mock(null, [], 1);
    await revokeOtherUserTokens(db, "user-1", "current-hash", "user_logout_others");
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith("user_logout_others", "user-1", "current-hash");
  });

  it("SQLにtoken_hash != ?とrevoked_at IS NULLが含まれる", async () => {
    const db = makeD1Mock(null, [], 1);
    await revokeOtherUserTokens(db, "user-1", "current-hash");
    const sql: string = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sql).toContain("token_hash != ?");
    expect(sql).toContain("revoked_at IS NULL");
    expect(sql).toContain("user_id = ?");
  });
});

describe("getServiceTokenStats", () => {
  it("全サービスのトークン統計を返す", async () => {
    const mockStats: ServiceTokenStat[] = [
      {
        service_id: "svc-1",
        service_name: "Service A",
        authorized_user_count: 5,
        active_token_count: 8,
      },
      {
        service_id: "svc-2",
        service_name: "Service B",
        authorized_user_count: 2,
        active_token_count: 2,
      },
    ];
    const db = makeD1Mock(null, mockStats);
    const result = await getServiceTokenStats(db);
    expect(result).toEqual(mockStats);
    expect(db.prepare).toHaveBeenCalledOnce();
  });

  it("サービスが存在しない場合は空配列を返す", async () => {
    const db = makeD1Mock(null, []);
    const result = await getServiceTokenStats(db);
    expect(result).toEqual([]);
  });
});

describe("revokeAllServiceTokens", () => {
  it("失効したトークン数を返す", async () => {
    const db = makeD1Mock(null, [], 5);
    const result = await revokeAllServiceTokens(db, "service-1");
    expect(result).toBe(5);
  });

  it("対象がない場合は0を返す", async () => {
    const db = makeD1Mock(null, [], 0);
    const result = await revokeAllServiceTokens(db, "service-1");
    expect(result).toBe(0);
  });

  it("serviceIdでbindを呼ぶ", async () => {
    const db = makeD1Mock(null, [], 3);
    await revokeAllServiceTokens(db, "service-1");
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith(null, "service-1");
  });

  it("SQLにservice_id = ?とrevoked_at IS NULLが含まれる", async () => {
    const db = makeD1Mock(null, [], 1);
    await revokeAllServiceTokens(db, "service-1");
    const sql: string = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sql).toContain("service_id = ?");
    expect(sql).toContain("revoked_at IS NULL");
    expect(sql).not.toContain("user_id");
  });

  it("reasonを指定した場合はrevoked_reasonに記録する", async () => {
    const db = makeD1Mock(null, [], 5);
    await revokeAllServiceTokens(db, "service-1", "service_delete");
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith("service_delete", "service-1");
  });
});

describe("findRefreshTokenById", () => {
  it("存在するidに対してRefreshTokenを返す", async () => {
    const db = makeD1Mock(baseToken);
    const result = await findRefreshTokenById(db, "token-id-1");
    expect(result).not.toBeNull();
    expect(result?.id).toBe("token-id-1");
    expect(result?.user_id).toBe("user-1");
  });

  it("存在しないidにはnullを返す", async () => {
    const db = makeD1Mock(null);
    const result = await findRefreshTokenById(db, "no-such-id");
    expect(result).toBeNull();
  });

  it("idでbindを呼ぶ", async () => {
    const db = makeD1Mock(baseToken);
    await findRefreshTokenById(db, "token-id-1");
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith("token-id-1");
  });
});

describe("findAndRevokeRefreshToken", () => {
  it("存在するhashのトークンをrevokeしてRefreshTokenを返す", async () => {
    const revokedToken = {
      ...baseToken,
      revoked_at: "2024-06-01T00:00:00Z",
      revoked_reason: "rotation",
    };
    const db = makeD1Mock(revokedToken);
    const result = await findAndRevokeRefreshToken(db, "hash-abc", "rotation");
    expect(result).not.toBeNull();
    expect(result?.id).toBe("token-id-1");
  });

  it("存在しないhash（または既に失効済み）にはnullを返す", async () => {
    const db = makeD1Mock(null);
    const result = await findAndRevokeRefreshToken(db, "no-such-hash");
    expect(result).toBeNull();
  });

  it("reasonなしのときnullでbindを呼ぶ", async () => {
    const db = makeD1Mock(baseToken);
    await findAndRevokeRefreshToken(db, "hash-abc");
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith(null, "hash-abc");
  });

  it("reasonありのときreasonでbindを呼ぶ", async () => {
    const db = makeD1Mock(baseToken);
    await findAndRevokeRefreshToken(db, "hash-abc", "reuse_detected");
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith("reuse_detected", "hash-abc");
  });

  it("RETURNING *を含むSQL文を実行する", async () => {
    const db = makeD1Mock(baseToken);
    await findAndRevokeRefreshToken(db, "hash-abc");
    const sql: string = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sql).toContain("RETURNING *");
    expect(sql).toContain("token_hash = ?");
    expect(sql).toContain("revoked_at IS NULL");
  });
});

describe("unrevokeRefreshToken", () => {
  it("changesが1以上のときtrueを返す", async () => {
    const db = makeD1Mock(null, [], 1);
    const result = await unrevokeRefreshToken(db, "token-id-1");
    expect(result).toBe(true);
  });

  it("changesが0のときfalseを返す", async () => {
    const db = makeD1Mock(null, [], 0);
    const result = await unrevokeRefreshToken(db, "token-id-1");
    expect(result).toBe(false);
  });

  it("DB例外時にリトライしてmaxRetries超過後にthrowする", async () => {
    const dbError = new Error("D1 transient error");
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(null),
      run: vi.fn().mockRejectedValue(dbError),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;
    await expect(unrevokeRefreshToken(db, "token-id-1", 1)).rejects.toThrow("D1 transient error");
    expect(stmt.run).toHaveBeenCalledTimes(2);
  });

  it("idとrevoked_reason=rotationでWHERE条件を持つSQL文を実行する", async () => {
    const db = makeD1Mock(null, [], 1);
    await unrevokeRefreshToken(db, "token-id-1");
    const sql: string = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sql).toContain("revoked_at = NULL");
    expect(sql).toContain("revoked_reason = 'rotation'");
  });
});

describe("deleteExpiredRefreshTokens", () => {
  it("削除件数を返す", async () => {
    const db = makeD1Mock(null, [], 7);
    const result = await deleteExpiredRefreshTokens(db);
    expect(result).toBe(7);
  });

  it("対象がない場合は0を返す", async () => {
    const db = makeD1Mock(null, [], 0);
    const result = await deleteExpiredRefreshTokens(db);
    expect(result).toBe(0);
  });

  it("expires_atまたは古いrevoked_atでDELETE文を実行する", async () => {
    const db = makeD1Mock(null, [], 3);
    await deleteExpiredRefreshTokens(db);
    const sql: string = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sql).toContain("DELETE FROM refresh_tokens");
    expect(sql).toContain("expires_at");
    expect(sql).toContain("revoked_at");
  });
});

describe("findUserIdByPairwiseSub", () => {
  it("存在するpairwiseSubのuser_idを返す", async () => {
    const db = makeD1Mock({ user_id: "user-1" });
    const result = await findUserIdByPairwiseSub(db, "service-1", "pairwise-abc");
    expect(result).toBe("user-1");
  });

  it("存在しないpairwiseSubにはnullを返す", async () => {
    const db = makeD1Mock(null);
    const result = await findUserIdByPairwiseSub(db, "service-1", "no-such-sub");
    expect(result).toBeNull();
  });

  it("serviceId・pairwiseSubでbindを呼ぶ", async () => {
    const db = makeD1Mock({ user_id: "user-1" });
    await findUserIdByPairwiseSub(db, "service-1", "pairwise-abc");
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith("service-1", "pairwise-abc");
  });

  it("SQLにservice_id・pairwise_sub・revoked_at IS NULL・expires_atが含まれる", async () => {
    const db = makeD1Mock(null);
    await findUserIdByPairwiseSub(db, "service-1", "pairwise-abc");
    const sql: string = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sql).toContain("service_id = ?");
    expect(sql).toContain("pairwise_sub = ?");
    expect(sql).toContain("revoked_at IS NULL");
    expect(sql).toContain("expires_at");
  });
});

describe("revokeTokenByIdForUser", () => {
  it("失効したトークン数を返す", async () => {
    const db = makeD1Mock(null, [], 1);
    const result = await revokeTokenByIdForUser(db, "token-id-1", "user-1");
    expect(result).toBe(1);
  });

  it("対象がない場合は0を返す", async () => {
    const db = makeD1Mock(null, [], 0);
    const result = await revokeTokenByIdForUser(db, "token-id-1", "user-1");
    expect(result).toBe(0);
  });

  it("reasonなしのときid・userIdでbindを呼ぶ", async () => {
    const db = makeD1Mock(null, [], 1);
    await revokeTokenByIdForUser(db, "token-id-1", "user-1");
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith(null, "token-id-1", "user-1");
  });

  it("reasonを指定した場合はrevoked_reasonに記録する", async () => {
    const db = makeD1Mock(null, [], 1);
    await revokeTokenByIdForUser(db, "token-id-1", "user-1", "user_logout");
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith("user_logout", "token-id-1", "user-1");
  });

  it("SQLにid・user_id・revoked_at IS NULLが含まれる", async () => {
    const db = makeD1Mock(null, [], 1);
    await revokeTokenByIdForUser(db, "token-id-1", "user-1");
    const sql: string = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sql).toContain("id = ?");
    expect(sql).toContain("user_id = ?");
    expect(sql).toContain("revoked_at IS NULL");
  });
});

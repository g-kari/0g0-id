import { describe, it, expect, vi } from "vite-plus/test";
import {
  createDeviceCode,
  findDeviceCodeByUserCode,
  findDeviceCodeByHash,
  approveDeviceCode,
  denyDeviceCode,
  tryUpdateDeviceCodePolledAt,
  deleteDeviceCode,
  deleteApprovedDeviceCode,
  deleteExpiredDeviceCodes,
} from "./device-codes";
import type { DeviceCode } from "./device-codes";
import { makeD1Mock } from "./test-helpers";

const baseDeviceCode: DeviceCode = {
  id: "dc-id-1",
  device_code_hash: "hash-abc",
  user_code: "ABCD1234",
  service_id: "service-1",
  scope: "openid profile",
  expires_at: "2025-12-31T23:59:59Z",
  user_id: null,
  approved_at: null,
  denied_at: null,
  last_polled_at: null,
  created_at: "2024-01-01T00:00:00Z",
};

describe("createDeviceCode", () => {
  it("正しいパラメーターでINSERT文を実行する", async () => {
    const db = makeD1Mock();
    await createDeviceCode(db, {
      id: "dc-id-1",
      deviceCodeHash: "hash-abc",
      userCode: "ABCD1234",
      serviceId: "service-1",
      scope: "openid profile",
      expiresAt: "2025-12-31T23:59:59Z",
    });

    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO device_codes"));
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith(
      "dc-id-1",
      "hash-abc",
      "ABCD1234",
      "service-1",
      "openid profile",
      "2025-12-31T23:59:59Z",
    );
    expect(stmt.run).toHaveBeenCalled();
  });

  it("scope が null でも正常に動作する", async () => {
    const db = makeD1Mock();
    await createDeviceCode(db, {
      id: "dc-id-2",
      deviceCodeHash: "hash-xyz",
      userCode: "EFGH5678",
      serviceId: "service-1",
      scope: null,
      expiresAt: "2025-12-31T23:59:59Z",
    });
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith(
      "dc-id-2",
      "hash-xyz",
      "EFGH5678",
      "service-1",
      null,
      "2025-12-31T23:59:59Z",
    );
  });
});

describe("findDeviceCodeByUserCode", () => {
  it("存在するuser_codeに対してDeviceCodeを返す", async () => {
    const db = makeD1Mock(baseDeviceCode);
    const result = await findDeviceCodeByUserCode(db, "ABCD1234");
    expect(result).not.toBeNull();
    expect(result?.id).toBe("dc-id-1");
    expect(result?.user_code).toBe("ABCD1234");
    expect(result?.service_id).toBe("service-1");
  });

  it("存在しないuser_codeにはnullを返す", async () => {
    const db = makeD1Mock(null);
    const result = await findDeviceCodeByUserCode(db, "NOTFOUND");
    expect(result).toBeNull();
  });

  it("user_codeでbindを呼ぶ", async () => {
    const db = makeD1Mock(baseDeviceCode);
    await findDeviceCodeByUserCode(db, "ABCD1234");
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith("ABCD1234");
  });
});

describe("findDeviceCodeByHash", () => {
  it("存在するdevice_code_hashに対してDeviceCodeを返す", async () => {
    const db = makeD1Mock(baseDeviceCode);
    const result = await findDeviceCodeByHash(db, "hash-abc");
    expect(result).not.toBeNull();
    expect(result?.id).toBe("dc-id-1");
    expect(result?.device_code_hash).toBe("hash-abc");
  });

  it("存在しないhashにはnullを返す", async () => {
    const db = makeD1Mock(null);
    const result = await findDeviceCodeByHash(db, "no-such-hash");
    expect(result).toBeNull();
  });

  it("device_code_hashでbindを呼ぶ", async () => {
    const db = makeD1Mock(baseDeviceCode);
    await findDeviceCodeByHash(db, "hash-abc");
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith("hash-abc");
  });
});

describe("approveDeviceCode", () => {
  it("指定したidにuser_idとapproved_atを設定する", async () => {
    const db = makeD1Mock();
    await approveDeviceCode(db, "dc-id-1", "user-1");

    const sql: string = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sql).toContain("approved_at");
    expect(sql).toContain("user_id");
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith("user-1", "dc-id-1");
    expect(stmt.run).toHaveBeenCalled();
  });
});

describe("denyDeviceCode", () => {
  it("指定したidにdenied_atを設定する", async () => {
    const db = makeD1Mock();
    await denyDeviceCode(db, "dc-id-1");

    const sql: string = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sql).toContain("denied_at");
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith("dc-id-1");
    expect(stmt.run).toHaveBeenCalled();
  });
});

describe("tryUpdateDeviceCodePolledAt", () => {
  it("インターバル以上経過していれば更新してtrueを返す", async () => {
    const db = makeD1Mock(null, [], 1);
    const result = await tryUpdateDeviceCodePolledAt(db, "dc-id-1", 5);
    expect(result).toBe(true);
  });

  it("インターバル内の再ポーリングはfalseを返す（0件更新）", async () => {
    const db = makeD1Mock(null, [], 0);
    const result = await tryUpdateDeviceCodePolledAt(db, "dc-id-1", 5);
    expect(result).toBe(false);
  });

  it("meta.changes が undefined のときもfalseを返す", async () => {
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(null),
      run: vi.fn().mockResolvedValue({ meta: {} }),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    const db = { prepare: vi.fn().mockReturnValue(stmt) };
    const result = await tryUpdateDeviceCodePolledAt(db as unknown as D1Database, "dc-id-1", 5);
    expect(result).toBe(false);
  });

  it("SQLにlast_polled_at IS NULLの条件が含まれる", async () => {
    const db = makeD1Mock(null, [], 1);
    await tryUpdateDeviceCodePolledAt(db, "dc-id-1", 5);
    const sql: string = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sql).toContain("last_polled_at IS NULL");
    expect(sql).toContain("last_polled_at");
  });

  it("id・nowIso・thresholdの順でbindを呼ぶ", async () => {
    const db = makeD1Mock(null, [], 1);
    await tryUpdateDeviceCodePolledAt(db, "dc-id-1", 10);
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    const bindArgs = (stmt.bind as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(bindArgs[1]).toBe("dc-id-1");
  });
});

describe("deleteDeviceCode", () => {
  it("指定したidのデバイスコードを削除する", async () => {
    const db = makeD1Mock();
    await deleteDeviceCode(db, "dc-id-1");

    const sql: string = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sql).toContain("DELETE FROM device_codes");
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith("dc-id-1");
    expect(stmt.run).toHaveBeenCalled();
  });
});

describe("deleteApprovedDeviceCode", () => {
  it("承認済みコードを削除してtrueを返す（1件削除）", async () => {
    const db = makeD1Mock(null, [], 1);
    const result = await deleteApprovedDeviceCode(db, "dc-id-1");
    expect(result).toBe(true);
  });

  it("他リクエストが先に削除済みの場合はfalseを返す（0件削除）", async () => {
    const db = makeD1Mock(null, [], 0);
    const result = await deleteApprovedDeviceCode(db, "dc-id-1");
    expect(result).toBe(false);
  });

  it("SQLにapproved_at IS NOT NULLの条件が含まれる", async () => {
    const db = makeD1Mock(null, [], 1);
    await deleteApprovedDeviceCode(db, "dc-id-1");
    const sql: string = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sql).toContain("approved_at IS NOT NULL");
  });

  it("idでbindを呼ぶ", async () => {
    const db = makeD1Mock(null, [], 1);
    await deleteApprovedDeviceCode(db, "dc-id-1");
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith("dc-id-1");
  });
});

describe("deleteExpiredDeviceCodes", () => {
  it("期限切れのデバイスコードを削除するSQLを実行する", async () => {
    const db = makeD1Mock();
    await deleteExpiredDeviceCodes(db);

    const sql: string = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sql).toContain("DELETE FROM device_codes");
    expect(sql).toContain("expires_at");
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.run).toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import {
  getAccountLockout,
  isAccountLocked,
  recordFailedAttempt,
  resetFailedAttempts,
  clearLockout,
} from "./account-lockouts";
import { makeD1Mock } from "./test-helpers";

describe("isAccountLocked", () => {
  it("ロックアウト行がない場合 → locked: false", async () => {
    const db = makeD1Mock(null);
    const result = await isAccountLocked(db, "user-1");
    expect(result).toEqual({ locked: false, lockedUntil: null, failedAttempts: 0 });
  });

  it("locked_untilがnull → locked: false, failedAttempts保持", async () => {
    const db = makeD1Mock({
      user_id: "user-1",
      failed_attempts: 3,
      locked_until: null,
      last_failed_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    });
    const result = await isAccountLocked(db, "user-1");
    expect(result).toEqual({ locked: false, lockedUntil: null, failedAttempts: 3 });
  });

  it("locked_untilが未来 → locked: true", async () => {
    const futureDate = new Date(Date.now() + 600_000).toISOString();
    const db = makeD1Mock({
      user_id: "user-1",
      failed_attempts: 6,
      locked_until: futureDate,
      last_failed_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    });
    const result = await isAccountLocked(db, "user-1");
    expect(result.locked).toBe(true);
    expect(result.lockedUntil).toBe(futureDate);
    expect(result.failedAttempts).toBe(6);
  });

  it("locked_untilが過去 → locked: false", async () => {
    const pastDate = new Date(Date.now() - 600_000).toISOString();
    const db = makeD1Mock({
      user_id: "user-1",
      failed_attempts: 6,
      locked_until: pastDate,
      last_failed_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    });
    const result = await isAccountLocked(db, "user-1");
    expect(result.locked).toBe(false);
    expect(result.lockedUntil).toBeNull();
    expect(result.failedAttempts).toBe(6);
  });
});

describe("recordFailedAttempt", () => {
  it("INSERT ... ON CONFLICT UPSERTクエリを実行する", async () => {
    const db = makeD1Mock({ user_id: "user-1", failed_attempts: 1 } as never);
    await recordFailedAttempt(db, "user-1");
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("ON CONFLICT"));
  });

  it("閾値以下 → locked: false", async () => {
    const db = makeD1Mock({
      user_id: "user-1",
      failed_attempts: 3,
      locked_until: null,
      last_failed_at: null,
      updated_at: "2026-01-01T00:00:00Z",
    });
    const result = await recordFailedAttempt(db, "user-1");
    expect(result.locked).toBe(false);
    expect(result.failedAttempts).toBe(3);
  });

  it("閾値超過 → locked: true, lockedUntilが設定される", async () => {
    const db = makeD1Mock({
      user_id: "user-1",
      failed_attempts: 6,
      locked_until: null,
      last_failed_at: null,
      updated_at: "2026-01-01T00:00:00Z",
    });
    const result = await recordFailedAttempt(db, "user-1");
    expect(result.locked).toBe(true);
    expect(result.lockedUntil).not.toBeNull();
    expect(result.failedAttempts).toBe(6);
  });
});

describe("resetFailedAttempts", () => {
  it("DELETEクエリを実行する", async () => {
    const db = makeD1Mock();
    await resetFailedAttempts(db, "user-1");
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM account_lockouts"),
    );
  });
});

describe("clearLockout", () => {
  it("resetFailedAttemptsと同じ関数", () => {
    expect(clearLockout).toBe(resetFailedAttempts);
  });
});

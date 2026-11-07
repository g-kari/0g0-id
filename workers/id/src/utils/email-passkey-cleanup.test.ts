import { describe, expect, it, vi } from "vite-plus/test";
import { cleanupEmailPasskeyState } from "./email-passkey-cleanup";

describe("email signup cleanup rollout gates", () => {
  it.each([undefined, "false", "1", true])("does no DB work while off (%s)", async (enabled) => {
    const prepare = vi.fn();
    expect(await cleanupEmailPasskeyState({ prepare } as unknown as D1Database, enabled)).toEqual({
      status: "disabled",
    });
    expect(prepare).not.toHaveBeenCalled();
  });
  it.each([null, { n: 0 }, { n: 1 }])(
    "does not touch absent or partial proposal schema (%s)",
    async (row) => {
      const prepare = vi.fn(() => ({ first: async () => row }));
      const batch = vi.fn();
      expect(
        await cleanupEmailPasskeyState({ prepare, batch } as unknown as D1Database, "true"),
      ).toEqual({ status: "schema_missing" });
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(batch).not.toHaveBeenCalled();
    },
  );
  it("settles without retrying delivery and retains expired evidence beyond one day", async () => {
    const statements: { sql: string; values: unknown[] }[] = [];
    const prepare = vi.fn((sql: string) => ({
      first: async () => ({ n: 2 }),
      bind: (...values: unknown[]) => {
        const statement = { sql, values };
        statements.push(statement);
        return statement;
      },
    }));
    const batch = vi.fn(async () => []);
    const before = Math.floor(Date.now() / 1000);
    expect(
      await cleanupEmailPasskeyState({ prepare, batch } as unknown as D1Database, "true"),
    ).toEqual({ status: "completed" });
    expect(batch).toHaveBeenCalledTimes(1);
    expect(statements).toHaveLength(3);
    expect(statements[0].sql).toContain("SET state = 'uncertain'");
    expect(statements[1].sql).toContain("SET state = 'discarded'");
    expect(statements[2].sql).toBe("DELETE FROM email_signup_intents WHERE expires_at <= ?");
    expect(statements[2].values[0]).toBeGreaterThanOrEqual(before - 86400);
    expect(statements[2].values[0]).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) - 86400);
  });
  it("propagates database failure rather than reporting a successful cleanup", async () => {
    const prepare = vi.fn(() => ({ first: async () => ({ n: 2 }), bind: () => ({}) }));
    const batch = vi.fn(async () => {
      throw new Error("synthetic failure");
    });
    await expect(
      cleanupEmailPasskeyState({ prepare, batch } as unknown as D1Database, "true"),
    ).rejects.toThrow("synthetic failure");
  });
});

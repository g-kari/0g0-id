import { describe, expect, it, vi } from "vite-plus/test";
import { cleanupNativePasskeyChallenges } from "./native-passkey-cleanup";

describe("native passkey cleanup rollout gates", () => {
  it.each([undefined, "false", "1", true])(
    "does not read or delete proposed tables while off (%s)",
    async (enabled) => {
      const prepare = vi.fn();
      expect(
        await cleanupNativePasskeyChallenges({ prepare } as unknown as D1Database, enabled),
      ).toEqual({ status: "disabled" });
      expect(prepare).not.toHaveBeenCalled();
    },
  );
  it("reports absent schema without attempting deletion", async () => {
    const prepare = vi.fn(() => ({ first: async () => null }));
    expect(
      await cleanupNativePasskeyChallenges({ prepare } as unknown as D1Database, "true"),
    ).toEqual({ status: "schema_missing" });
    expect(prepare).toHaveBeenCalledTimes(1);
  });
  it("deletes only expired challenges after the explicit flag and table check", async () => {
    const prepare = vi.fn((sql: string) =>
      sql.startsWith("SELECT")
        ? { first: async () => ({ name: "passkey_challenges" }) }
        : { bind: vi.fn(() => ({ run: async () => ({ meta: { changes: 2 } }) })) },
    );
    const result = await cleanupNativePasskeyChallenges(
      { prepare } as unknown as D1Database,
      "true",
    );
    expect(result).toEqual({ status: "completed" });
    expect(prepare.mock.calls[1][0]).toMatch(
      /DELETE FROM passkey_challenges WHERE expires_at <= \?/,
    );
  });
  it("does not misreport database failures as success", async () => {
    const prepare = vi.fn(() => {
      throw new Error("database unavailable");
    });
    await expect(
      cleanupNativePasskeyChallenges({ prepare } as unknown as D1Database, "true"),
    ).rejects.toThrow();
  });
});

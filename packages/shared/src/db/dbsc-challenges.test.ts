import { describe, it, expect, vi } from "vite-plus/test";
import {
  issueDbscChallenge,
  consumeDbscChallenge,
  cleanupStaleDbscChallenges,
} from "./dbsc-challenges";
import { makeD1Mock } from "./test-helpers";

describe("issueDbscChallenge", () => {
  it("INSERT INTO dbsc_challenges を実行し expires_at を TTL で設定する", async () => {
    const db = makeD1Mock();
    const before = Math.floor(Date.now() / 1000);
    const issued = await issueDbscChallenge(db, {
      nonce: "n-1",
      sessionId: "sid-1",
      ttlSeconds: 60,
    });
    const after = Math.floor(Date.now() / 1000);
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO dbsc_challenges"));
    expect(issued.nonce).toBe("n-1");
    expect(issued.session_id).toBe("sid-1");
    expect(issued.expires_at).toBeGreaterThanOrEqual(before + 60);
    expect(issued.expires_at).toBeLessThanOrEqual(after + 60);
    expect((db._stmt as unknown as { run: ReturnType<typeof vi.fn> }).run).toHaveBeenCalledOnce();
  });

  it("ttlSeconds 省略時は既定値 60 秒", async () => {
    const db = makeD1Mock();
    const issued = await issueDbscChallenge(db, { nonce: "n-2", sessionId: "sid-1" });
    const now = Math.floor(Date.now() / 1000);
    expect(issued.expires_at - now).toBeLessThanOrEqual(60);
    expect(issued.expires_at - now).toBeGreaterThan(55);
  });
});

describe("consumeDbscChallenge", () => {
  it("未消費 nonce を一回限り消費（changes=1）すると ok:true", async () => {
    const db = makeD1Mock(null, [], 1);
    const result = await consumeDbscChallenge(db, { nonce: "n-1", sessionId: "sid-1" });
    expect(result.ok).toBe(true);
    expect(result.session_id).toBe("sid-1");
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toContain("UPDATE dbsc_challenges");
    expect(sql).toContain("consumed_at IS NULL");
    expect(sql).toContain("expires_at > ?");
    expect(sql).toContain("session_id = ?");
  });

  it("changes=0（期限切れ/消費済み/不一致）なら ok:false", async () => {
    const db = makeD1Mock(null, [], 0);
    const result = await consumeDbscChallenge(db, { nonce: "n-1", sessionId: "sid-1" });
    expect(result.ok).toBe(false);
    expect(result.session_id).toBeUndefined();
  });
});

describe("cleanupStaleDbscChallenges", () => {
  it("DELETE を実行する（期限切れ or 消費済み経過分）", async () => {
    const db = makeD1Mock();
    await cleanupStaleDbscChallenges(db);
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toContain("DELETE FROM dbsc_challenges");
    expect(sql).toContain("expires_at < ?");
    expect(sql).toContain("consumed_at IS NOT NULL");
  });
});

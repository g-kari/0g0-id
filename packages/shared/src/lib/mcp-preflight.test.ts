import { describe, it, expect } from "vite-plus/test";
import { runMcpPreflight, type PreflightRunner } from "./mcp-preflight";

function makeRunner(env?: Record<string, string | undefined>): {
  runner: PreflightRunner;
  logs: string[];
} {
  const logs: string[] = [];
  const runner: PreflightRunner = {
    runWranglerSecretList: () => ({ ok: true, stdout: "[]" }),
    getEnv: (key) => env?.[key],
    log: (m) => logs.push(m),
    warn: (m) => logs.push(m),
    error: (m) => logs.push(m),
  };
  return { runner, logs };
}

describe("runMcpPreflight", () => {
  it("SKIP_PREFLIGHT=1 で skipped を返す", () => {
    const { runner } = makeRunner({ SKIP_PREFLIGHT: "1" });
    const outcome = runMcpPreflight("mcp", runner);
    expect(outcome).toEqual({ kind: "skipped" });
  });

  it("通常実行で ok を返しログを出す", () => {
    const { runner, logs } = makeRunner();
    const outcome = runMcpPreflight("mcp", runner);
    expect(outcome).toEqual({ kind: "ok" });
    expect(logs[0]).toContain("[preflight:mcp]");
    expect(logs[0]).toContain("No secrets to verify");
  });

  it("SKIP_PREFLIGHT が '1' 以外ではスキップしない", () => {
    const { runner } = makeRunner({ SKIP_PREFLIGHT: "0" });
    expect(runMcpPreflight("mcp", runner)).toEqual({ kind: "ok" });
  });
});

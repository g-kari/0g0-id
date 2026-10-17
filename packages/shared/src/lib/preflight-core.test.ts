import { describe, it, expect, vi } from "vite-plus/test";
import {
  parseWranglerSecretList,
  runPreflightCore,
  type PreflightRunner,
  type PreflightConfig,
} from "./preflight-core";

describe("parseWranglerSecretList", () => {
  it("正常な JSON 配列をパースする", () => {
    const raw = JSON.stringify([
      { name: "SECRET_A", type: "secret_text" },
      { name: "SECRET_B", type: "secret_text" },
    ]);
    const result = parseWranglerSecretList(raw);
    expect(result).toEqual([
      { name: "SECRET_A", type: "secret_text" },
      { name: "SECRET_B", type: "secret_text" },
    ]);
  });

  it("空配列を返す", () => {
    expect(parseWranglerSecretList("[]")).toEqual([]);
  });

  it("name を持たないエントリをフィルタする", () => {
    const raw = JSON.stringify([{ name: "A" }, { foo: "bar" }, { name: 123 }]);
    const result = parseWranglerSecretList(raw);
    expect(result).toEqual([{ name: "A" }]);
  });

  it("配列でない JSON はエラーを投げる", () => {
    expect(() => parseWranglerSecretList('{"name":"A"}')).toThrow("not a JSON array");
  });

  it("無効な JSON はエラーを投げる", () => {
    expect(() => parseWranglerSecretList("not json")).toThrow();
  });
});

function createMockRunner(overrides: Partial<PreflightRunner> = {}): PreflightRunner {
  return {
    runWranglerSecretList: () => ({ ok: true as const, stdout: "[]" }),
    getEnv: () => undefined,
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    ...overrides,
  };
}

function createConfig(overrides: Partial<PreflightConfig> = {}): PreflightConfig {
  return {
    secretName: "MY_SECRET",
    classify: (entries) =>
      entries.some((e) => e.name === "MY_SECRET")
        ? { kind: "configured", level: "info" }
        : { kind: "missing", level: "warn" },
    format: (worker, status) =>
      status.kind === "configured"
        ? `[${worker}] MY_SECRET is configured`
        : `[${worker}] MY_SECRET is missing`,
    ...overrides,
  };
}

describe("runPreflightCore", () => {
  it("SKIP_PREFLIGHT=1 でスキップされる", () => {
    const runner = createMockRunner({ getEnv: (k) => (k === "SKIP_PREFLIGHT" ? "1" : undefined) });
    const result = runPreflightCore("test-worker", runner, createConfig());
    expect(result.kind).toBe("skipped");
  });

  it("wrangler 失敗時は wrangler-failed を返す", () => {
    const runner = createMockRunner({
      runWranglerSecretList: () => ({ ok: false as const, exitCode: 1, stderr: "auth error" }),
    });
    const result = runPreflightCore("test-worker", runner, createConfig());
    expect(result.kind).toBe("wrangler-failed");
    if (result.kind === "wrangler-failed") {
      expect(result.exitCode).toBe(1);
    }
  });

  it("JSON パース失敗時は parse-failed を返す", () => {
    const runner = createMockRunner({
      runWranglerSecretList: () => ({ ok: true as const, stdout: "not json" }),
    });
    const result = runPreflightCore("test-worker", runner, createConfig());
    expect(result.kind).toBe("parse-failed");
  });

  it("secret が登録済みの場合は configured を返す", () => {
    const runner = createMockRunner({
      runWranglerSecretList: () => ({
        ok: true as const,
        stdout: JSON.stringify([{ name: "MY_SECRET" }]),
      }),
    });
    const result = runPreflightCore("test-worker", runner, createConfig());
    expect(result.kind).toBe("configured");
  });

  it("secret 未登録 + strict なしで missing-warn を返す", () => {
    const runner = createMockRunner();
    const result = runPreflightCore("test-worker", runner, createConfig());
    expect(result.kind).toBe("missing-warn");
  });

  it("secret 未登録 + PREFLIGHT_STRICT=1 で missing-strict を返す", () => {
    const runner = createMockRunner({
      getEnv: (k) => (k === "PREFLIGHT_STRICT" ? "1" : undefined),
    });
    const result = runPreflightCore("test-worker", runner, createConfig());
    expect(result.kind).toBe("missing-strict");
  });

  it("PREFLIGHT_STRICT が 1 以外の非空値では strict にならず warn が出る", () => {
    const runner = createMockRunner({
      getEnv: (k) => (k === "PREFLIGHT_STRICT" ? "true" : undefined),
    });
    const result = runPreflightCore("test-worker", runner, createConfig());
    expect(result.kind).toBe("missing-warn");
    expect(runner.warn).toHaveBeenCalledWith(
      expect.stringContaining("strict mode was NOT applied"),
    );
  });

  it("SKIP_PREFLIGHT=1 が PREFLIGHT_STRICT=1 より優先される", () => {
    const runner = createMockRunner({
      getEnv: (k) => {
        if (k === "SKIP_PREFLIGHT") return "1";
        if (k === "PREFLIGHT_STRICT") return "1";
        return undefined;
      },
    });
    const result = runPreflightCore("test-worker", runner, createConfig());
    expect(result.kind).toBe("skipped");
  });

  it("wrangler stderr が空でも warn を 1 回だけ出す", () => {
    const runner = createMockRunner({
      runWranglerSecretList: () => ({ ok: false as const, exitCode: null, stderr: "" }),
    });
    runPreflightCore("test-worker", runner, createConfig());
    expect(runner.warn).toHaveBeenCalledTimes(1);
  });
});

import { describe, it, expect } from "vite-plus/test";
import {
  classifyDbscSecret,
  formatDbscStatus,
  parseWranglerSecretList,
  runPreflight,
  DBSC_ENFORCE_SECRET_NAME,
  type PreflightRunner,
} from "./bff-preflight";

interface LogBuffer {
  logs: string[];
  warns: string[];
  errors: string[];
}

function makeRunner(overrides: {
  env?: Record<string, string | undefined>;
  wrangler: { ok: true; stdout: string } | { ok: false; exitCode: number | null; stderr: string };
}): { runner: PreflightRunner; buf: LogBuffer } {
  const env = overrides.env ?? {};
  const buf: LogBuffer = { logs: [], warns: [], errors: [] };
  const runner: PreflightRunner = {
    runWranglerSecretList: () => overrides.wrangler,
    getEnv: (key) => env[key],
    log: (m) => buf.logs.push(m),
    warn: (m) => buf.warns.push(m),
    error: (m) => buf.errors.push(m),
  };
  return { runner, buf };
}

describe("classifyDbscSecret", () => {
  it("DBSC_ENFORCE_SENSITIVE が含まれれば configured を返す", () => {
    const status = classifyDbscSecret([
      { name: "JWT_PUBLIC_KEY" },
      { name: DBSC_ENFORCE_SECRET_NAME },
      { name: "SESSION_SECRET" },
    ]);
    expect(status).toEqual({ kind: "configured", level: "info" });
  });

  it("未登録なら missing を返す", () => {
    const status = classifyDbscSecret([{ name: "JWT_PUBLIC_KEY" }, { name: "SESSION_SECRET" }]);
    expect(status).toEqual({ kind: "missing", level: "warn" });
  });

  it("空配列は missing を返す", () => {
    expect(classifyDbscSecret([])).toEqual({ kind: "missing", level: "warn" });
  });

  it("name が非文字列のエントリが混じっても落ちずに扱う", () => {
    const status = classifyDbscSecret([
      { name: DBSC_ENFORCE_SECRET_NAME },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { name: 42 as any },
    ]);
    expect(status).toEqual({ kind: "configured", level: "info" });
  });

  it("類似名（prefix/suffix）では configured にしない", () => {
    const status = classifyDbscSecret([
      { name: "DBSC_ENFORCE_SENSITIVE_OLD" },
      { name: "DBSC_ENFORCE" },
      { name: "PREFIX_DBSC_ENFORCE_SENSITIVE" },
    ]);
    expect(status).toEqual({ kind: "missing", level: "warn" });
  });
});

describe("formatDbscStatus", () => {
  it("configured 時は worker 名と secret 名を含むメッセージを返す", () => {
    const msg = formatDbscStatus("user", { kind: "configured", level: "info" });
    expect(msg).toContain("[preflight:user]");
    expect(msg).toContain(DBSC_ENFORCE_SECRET_NAME);
    expect(msg).toContain("configured");
  });

  it("missing 時は wrangler secret put のガイド文言を含む", () => {
    const msg = formatDbscStatus("admin", { kind: "missing", level: "warn" });
    expect(msg).toContain("[preflight:admin]");
    expect(msg).toContain("NOT configured");
    expect(msg).toContain(`wrangler secret put ${DBSC_ENFORCE_SECRET_NAME}`);
    expect(msg).toContain("warn-only");
  });
});

describe("parseWranglerSecretList", () => {
  it("JSON 配列を SecretListEntry[] にパースする", () => {
    const raw = JSON.stringify([
      { name: "A", type: "secret_text" },
      { name: "B", type: "secret_text" },
    ]);
    expect(parseWranglerSecretList(raw)).toEqual([
      { name: "A", type: "secret_text" },
      { name: "B", type: "secret_text" },
    ]);
  });

  it("name が欠けたエントリは除外される", () => {
    const raw = JSON.stringify([{ name: "A" }, { type: "secret_text" }, { name: 123 }]);
    expect(parseWranglerSecretList(raw)).toEqual([{ name: "A" }]);
  });

  it("配列でない JSON はエラー", () => {
    expect(() => parseWranglerSecretList(JSON.stringify({ foo: "bar" }))).toThrow(
      /not a JSON array/,
    );
  });

  it("壊れた JSON はエラー", () => {
    expect(() => parseWranglerSecretList("{ not json")).toThrow();
  });
});

describe("runPreflight", () => {
  it("SKIP_PREFLIGHT=1 で skipped を返し wrangler を呼ばない", () => {
    let called = false;
    const runner: PreflightRunner = {
      runWranglerSecretList: () => {
        called = true;
        return { ok: true, stdout: "[]" };
      },
      getEnv: (k) => (k === "SKIP_PREFLIGHT" ? "1" : undefined),
      log: () => {},
      warn: () => {},
      error: () => {},
    };
    const outcome = runPreflight("user", runner);
    expect(outcome).toEqual({ kind: "skipped" });
    expect(called).toBe(false);
  });

  it("secret 設定済みなら configured を返し log に INFO を出す", () => {
    const { runner, buf } = makeRunner({
      wrangler: {
        ok: true,
        stdout: JSON.stringify([{ name: DBSC_ENFORCE_SECRET_NAME }]),
      },
    });
    const outcome = runPreflight("user", runner);
    expect(outcome).toEqual({ kind: "configured" });
    expect(buf.logs[0]).toContain("configured");
    expect(buf.warns).toHaveLength(0);
    expect(buf.errors).toHaveLength(0);
  });

  it("secret 未設定 + 非 strict なら missing-warn を返し warn のみ出す", () => {
    const { runner, buf } = makeRunner({
      wrangler: { ok: true, stdout: JSON.stringify([{ name: "OTHER" }]) },
    });
    const outcome = runPreflight("admin", runner);
    expect(outcome).toEqual({ kind: "missing-warn" });
    expect(buf.warns[0]).toContain("NOT configured");
    expect(buf.errors).toHaveLength(0);
  });

  it("secret 未設定 + PREFLIGHT_STRICT=1 なら missing-strict + error 出力", () => {
    const { runner, buf } = makeRunner({
      env: { PREFLIGHT_STRICT: "1" },
      wrangler: { ok: true, stdout: "[]" },
    });
    const outcome = runPreflight("admin", runner);
    expect(outcome).toEqual({ kind: "missing-strict" });
    expect(buf.warns.some((m) => m.includes("NOT configured"))).toBe(true);
    expect(buf.errors[0]).toContain("PREFLIGHT_STRICT=1");
    expect(buf.errors[0]).toContain("aborting deploy");
  });

  it("PREFLIGHT_STRICT が '1' 以外では strict 扱いせず、設定ミス警告を追加で出す", () => {
    const { runner, buf } = makeRunner({
      env: { PREFLIGHT_STRICT: "true" },
      wrangler: { ok: true, stdout: "[]" },
    });
    expect(runPreflight("user", runner)).toEqual({ kind: "missing-warn" });
    // 1本目: NOT configured メッセージ、2本目: STRICT 誤設定警告
    expect(buf.warns).toHaveLength(2);
    expect(buf.warns[1]).toContain('PREFLIGHT_STRICT="true"');
    expect(buf.warns[1]).toContain("strict mode was NOT applied");
    expect(buf.errors).toHaveLength(0);
  });

  it("PREFLIGHT_STRICT が空文字や undefined なら誤設定警告は出さない", () => {
    const { runner: r1, buf: b1 } = makeRunner({
      env: { PREFLIGHT_STRICT: "" },
      wrangler: { ok: true, stdout: "[]" },
    });
    expect(runPreflight("user", r1)).toEqual({ kind: "missing-warn" });
    expect(b1.warns).toHaveLength(1);

    const { runner: r2, buf: b2 } = makeRunner({
      wrangler: { ok: true, stdout: "[]" },
    });
    expect(runPreflight("user", r2)).toEqual({ kind: "missing-warn" });
    expect(b2.warns).toHaveLength(1);
  });

  it("SKIP_PREFLIGHT が PREFLIGHT_STRICT=1 より優先される", () => {
    const { runner, buf } = makeRunner({
      env: { SKIP_PREFLIGHT: "1", PREFLIGHT_STRICT: "1" },
      wrangler: { ok: true, stdout: "[]" },
    });
    expect(runPreflight("user", runner)).toEqual({ kind: "skipped" });
    expect(buf.warns).toHaveLength(0);
    expect(buf.errors).toHaveLength(0);
  });

  it("wrangler が非 0 exit → wrangler-failed を返し fail-open（strict 時も exit しない）", () => {
    const { runner, buf } = makeRunner({
      env: { PREFLIGHT_STRICT: "1" },
      wrangler: { ok: false, exitCode: 1, stderr: "Not logged in" },
    });
    const outcome = runPreflight("user", runner);
    expect(outcome).toEqual({ kind: "wrangler-failed", exitCode: 1 });
    expect(buf.warns[0]).toContain("wrangler secret list failed");
    // stderr は `[preflight:user] stderr: ...` の prefix 付きで出力される
    expect(buf.warns[1]).toContain("[preflight:user] stderr:");
    expect(buf.warns[1]).toContain("Not logged in");
  });

  it("パース不能な stdout → parse-failed を返し警告する", () => {
    const { runner, buf } = makeRunner({
      wrangler: { ok: true, stdout: "not json" },
    });
    const outcome = runPreflight("user", runner);
    expect(outcome.kind).toBe("parse-failed");
    expect(buf.warns[0]).toContain("could not parse");
  });

  it("stderr 空文字の場合は warn を余計に出さない", () => {
    const { runner, buf } = makeRunner({
      wrangler: { ok: false, exitCode: null, stderr: "   \n  " },
    });
    runPreflight("user", runner);
    // 1本目の wrangler failed 警告のみ。stderr trimmed が空なので追加 warn なし
    expect(buf.warns).toHaveLength(1);
  });
});

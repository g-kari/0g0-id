import { describe, it, expect } from "vite-plus/test";
import {
  classifyBffIndividualSecrets,
  classifyInternalSecretStrictSecret,
  formatBffIndividualSecretsStatus,
  formatInternalSecretStrictStatus,
  INTERNAL_SECRET_STRICT_NAME,
  INTERNAL_SERVICE_SECRET_ADMIN_NAME,
  INTERNAL_SERVICE_SECRET_USER_NAME,
  runBffIndividualSecretsPreflight,
  runInternalSecretStrictPreflight,
} from "./id-preflight";
import type { PreflightRunner } from "./preflight-core";

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

describe("classifyInternalSecretStrictSecret", () => {
  it("INTERNAL_SECRET_STRICT が含まれれば configured を返す", () => {
    const status = classifyInternalSecretStrictSecret([
      { name: "JWT_PUBLIC_KEY" },
      { name: INTERNAL_SECRET_STRICT_NAME },
      { name: "INTERNAL_SERVICE_SECRET_USER" },
    ]);
    expect(status).toEqual({ kind: "configured", level: "info" });
  });

  it("未登録なら missing を返す", () => {
    const status = classifyInternalSecretStrictSecret([
      { name: "INTERNAL_SERVICE_SECRET" },
      { name: "JWT_PUBLIC_KEY" },
    ]);
    expect(status).toEqual({ kind: "missing", level: "warn" });
  });

  it("空配列は missing を返す", () => {
    expect(classifyInternalSecretStrictSecret([])).toEqual({ kind: "missing", level: "warn" });
  });

  it("name が非文字列のエントリが混じっても落ちずに扱う", () => {
    const status = classifyInternalSecretStrictSecret([
      { name: INTERNAL_SECRET_STRICT_NAME },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { name: 42 as any },
    ]);
    expect(status).toEqual({ kind: "configured", level: "info" });
  });

  it("類似名（prefix/suffix）では configured にしない", () => {
    const status = classifyInternalSecretStrictSecret([
      { name: "INTERNAL_SECRET_STRICT_OLD" },
      { name: "INTERNAL_SECRET" },
      { name: "PREFIX_INTERNAL_SECRET_STRICT" },
    ]);
    expect(status).toEqual({ kind: "missing", level: "warn" });
  });
});

describe("formatInternalSecretStrictStatus", () => {
  it("configured 時は worker 名と secret 名を含むメッセージを返す", () => {
    const msg = formatInternalSecretStrictStatus("id", { kind: "configured", level: "info" });
    expect(msg).toContain("[preflight:id]");
    expect(msg).toContain(INTERNAL_SECRET_STRICT_NAME);
    expect(msg).toContain("configured");
  });

  it("missing 時は wrangler secret put のガイド文言と warn-only を含む", () => {
    const msg = formatInternalSecretStrictStatus("id", { kind: "missing", level: "warn" });
    expect(msg).toContain("[preflight:id]");
    expect(msg).toContain("NOT configured");
    expect(msg).toContain(`wrangler secret put ${INTERNAL_SECRET_STRICT_NAME}`);
    expect(msg).toContain("warn-only");
  });

  it("受理値の規則（/^true$/i trimmed）を文言で明示している", () => {
    const msg = formatInternalSecretStrictStatus("id", { kind: "missing", level: "warn" });
    // parseStrictBoolEnv と同じ規則。DBSC 向け文言と揃えてある。
    expect(msg).toContain("/^true$/i");
    expect(msg).toContain("trimmed");
  });
});

describe("runInternalSecretStrictPreflight", () => {
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
    const outcome = runInternalSecretStrictPreflight("id", runner);
    expect(outcome).toEqual({ kind: "skipped" });
    expect(called).toBe(false);
  });

  it("secret 設定済みなら configured を返し log に INFO を出す", () => {
    const { runner, buf } = makeRunner({
      wrangler: {
        ok: true,
        stdout: JSON.stringify([{ name: INTERNAL_SECRET_STRICT_NAME }]),
      },
    });
    const outcome = runInternalSecretStrictPreflight("id", runner);
    expect(outcome).toEqual({ kind: "configured" });
    expect(buf.logs[0]).toContain("configured");
    expect(buf.warns).toHaveLength(0);
    expect(buf.errors).toHaveLength(0);
  });

  it("secret 未設定 + 非 strict なら missing-warn を返し warn のみ出す", () => {
    const { runner, buf } = makeRunner({
      wrangler: { ok: true, stdout: JSON.stringify([{ name: "OTHER" }]) },
    });
    const outcome = runInternalSecretStrictPreflight("id", runner);
    expect(outcome).toEqual({ kind: "missing-warn" });
    expect(buf.warns[0]).toContain("NOT configured");
    expect(buf.errors).toHaveLength(0);
  });

  it("secret 未設定 + PREFLIGHT_STRICT=1 なら missing-strict + error 出力", () => {
    const { runner, buf } = makeRunner({
      env: { PREFLIGHT_STRICT: "1" },
      wrangler: { ok: true, stdout: "[]" },
    });
    const outcome = runInternalSecretStrictPreflight("id", runner);
    expect(outcome).toEqual({ kind: "missing-strict" });
    expect(buf.warns.some((m) => m.includes("NOT configured"))).toBe(true);
    expect(buf.errors[0]).toContain("PREFLIGHT_STRICT=1");
    expect(buf.errors[0]).toContain(INTERNAL_SECRET_STRICT_NAME);
    expect(buf.errors[0]).toContain("aborting deploy");
  });

  it("PREFLIGHT_STRICT が '1' 以外では strict 扱いせず、設定ミス警告を追加で出す", () => {
    const { runner, buf } = makeRunner({
      env: { PREFLIGHT_STRICT: "true" },
      wrangler: { ok: true, stdout: "[]" },
    });
    expect(runInternalSecretStrictPreflight("id", runner)).toEqual({ kind: "missing-warn" });
    expect(buf.warns).toHaveLength(2);
    expect(buf.warns[1]).toContain('PREFLIGHT_STRICT="true"');
    expect(buf.warns[1]).toContain("strict mode was NOT applied");
    expect(buf.errors).toHaveLength(0);
  });

  it("SKIP_PREFLIGHT が PREFLIGHT_STRICT=1 より優先される", () => {
    const { runner, buf } = makeRunner({
      env: { SKIP_PREFLIGHT: "1", PREFLIGHT_STRICT: "1" },
      wrangler: { ok: true, stdout: "[]" },
    });
    expect(runInternalSecretStrictPreflight("id", runner)).toEqual({ kind: "skipped" });
    expect(buf.warns).toHaveLength(0);
    expect(buf.errors).toHaveLength(0);
  });

  it("wrangler が非 0 exit → wrangler-failed を返し fail-open（strict 時も exit しない）", () => {
    const { runner, buf } = makeRunner({
      env: { PREFLIGHT_STRICT: "1" },
      wrangler: { ok: false, exitCode: 1, stderr: "Not logged in" },
    });
    const outcome = runInternalSecretStrictPreflight("id", runner);
    expect(outcome).toEqual({ kind: "wrangler-failed", exitCode: 1 });
    expect(buf.warns[0]).toContain("wrangler secret list failed");
    expect(buf.warns[0]).toContain(INTERNAL_SECRET_STRICT_NAME);
    expect(buf.warns[1]).toContain("[preflight:id] stderr:");
    expect(buf.warns[1]).toContain("Not logged in");
  });

  it("パース不能な stdout → parse-failed を返し警告する", () => {
    const { runner, buf } = makeRunner({
      wrangler: { ok: true, stdout: "not json" },
    });
    const outcome = runInternalSecretStrictPreflight("id", runner);
    expect(outcome.kind).toBe("parse-failed");
    expect(buf.warns[0]).toContain("could not parse");
  });

  it("stderr 空文字の場合は warn を余計に出さない", () => {
    const { runner, buf } = makeRunner({
      wrangler: { ok: false, exitCode: null, stderr: "   \n  " },
    });
    runInternalSecretStrictPreflight("id", runner);
    expect(buf.warns).toHaveLength(1);
  });
});

// issue #156 Phase 8: 個別 BFF シークレット（USER/ADMIN）の preflight

describe("classifyBffIndividualSecrets", () => {
  it("USER と ADMIN が両方あれば両方 configured を返す", () => {
    expect(
      classifyBffIndividualSecrets([
        { name: INTERNAL_SERVICE_SECRET_USER_NAME },
        { name: INTERNAL_SERVICE_SECRET_ADMIN_NAME },
      ]),
    ).toEqual({ userConfigured: true, adminConfigured: true });
  });

  it("USER のみ登録なら admin だけ未登録", () => {
    expect(classifyBffIndividualSecrets([{ name: INTERNAL_SERVICE_SECRET_USER_NAME }])).toEqual({
      userConfigured: true,
      adminConfigured: false,
    });
  });

  it("ADMIN のみ登録なら user だけ未登録", () => {
    expect(classifyBffIndividualSecrets([{ name: INTERNAL_SERVICE_SECRET_ADMIN_NAME }])).toEqual({
      userConfigured: false,
      adminConfigured: true,
    });
  });

  it("どちらも無ければ両方 false", () => {
    expect(classifyBffIndividualSecrets([{ name: "INTERNAL_SERVICE_SECRET" }])).toEqual({
      userConfigured: false,
      adminConfigured: false,
    });
  });

  it("name が非文字列のエントリは無視する", () => {
    expect(
      classifyBffIndividualSecrets([
        { name: INTERNAL_SERVICE_SECRET_USER_NAME },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { name: 42 as any },
      ]),
    ).toEqual({ userConfigured: true, adminConfigured: false });
  });

  it("類似名（prefix/suffix）では configured にしない", () => {
    expect(
      classifyBffIndividualSecrets([
        { name: `${INTERNAL_SERVICE_SECRET_USER_NAME}_OLD` },
        { name: `PREFIX_${INTERNAL_SERVICE_SECRET_ADMIN_NAME}` },
      ]),
    ).toEqual({ userConfigured: false, adminConfigured: false });
  });
});

describe("formatBffIndividualSecretsStatus", () => {
  it("両方 configured 時は成功メッセージを返す", () => {
    const msg = formatBffIndividualSecretsStatus("id", {
      userConfigured: true,
      adminConfigured: true,
    });
    expect(msg).toContain("[preflight:id]");
    expect(msg).toContain("both configured");
    expect(msg).toContain(INTERNAL_SERVICE_SECRET_USER_NAME);
    expect(msg).toContain(INTERNAL_SERVICE_SECRET_ADMIN_NAME);
  });

  it("USER のみ未登録時は missing に USER を列挙する", () => {
    const msg = formatBffIndividualSecretsStatus("id", {
      userConfigured: false,
      adminConfigured: true,
    });
    expect(msg).toContain("Missing: " + INTERNAL_SERVICE_SECRET_USER_NAME);
    expect(msg).not.toContain("Missing: " + INTERNAL_SERVICE_SECRET_ADMIN_NAME);
    expect(msg).toContain("403 DEPRECATED_INTERNAL_SECRET");
  });

  it("両方未登録時は両方を missing に列挙し wrangler secret put のガイドを含む", () => {
    const msg = formatBffIndividualSecretsStatus("id", {
      userConfigured: false,
      adminConfigured: false,
    });
    expect(msg).toContain(INTERNAL_SERVICE_SECRET_USER_NAME);
    expect(msg).toContain(INTERNAL_SERVICE_SECRET_ADMIN_NAME);
    expect(msg).toContain("wrangler secret put");
    expect(msg).toContain("strict mode");
  });
});

describe("runBffIndividualSecretsPreflight", () => {
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
    const outcome = runBffIndividualSecretsPreflight("id", runner);
    expect(outcome).toEqual({ kind: "skipped" });
    expect(called).toBe(false);
  });

  it("両方 configured なら configured を返し INFO ログを出す", () => {
    const { runner, buf } = makeRunner({
      wrangler: {
        ok: true,
        stdout: JSON.stringify([
          { name: INTERNAL_SERVICE_SECRET_USER_NAME },
          { name: INTERNAL_SERVICE_SECRET_ADMIN_NAME },
          { name: "OTHER" },
        ]),
      },
    });
    const outcome = runBffIndividualSecretsPreflight("id", runner);
    expect(outcome).toEqual({ kind: "configured" });
    expect(buf.logs[0]).toContain("both configured");
    expect(buf.warns).toHaveLength(0);
    expect(buf.errors).toHaveLength(0);
  });

  it("片方未登録 + 非 strict なら missing-warn を返し warn のみ出す", () => {
    const { runner, buf } = makeRunner({
      wrangler: {
        ok: true,
        stdout: JSON.stringify([{ name: INTERNAL_SERVICE_SECRET_USER_NAME }]),
      },
    });
    const outcome = runBffIndividualSecretsPreflight("id", runner);
    expect(outcome).toEqual({
      kind: "missing-warn",
      missing: [INTERNAL_SERVICE_SECRET_ADMIN_NAME],
    });
    expect(buf.warns[0]).toContain("Missing: " + INTERNAL_SERVICE_SECRET_ADMIN_NAME);
    expect(buf.errors).toHaveLength(0);
  });

  it("両方未登録 + PREFLIGHT_STRICT=1 なら missing-strict + error 出力", () => {
    const { runner, buf } = makeRunner({
      env: { PREFLIGHT_STRICT: "1" },
      wrangler: { ok: true, stdout: "[]" },
    });
    const outcome = runBffIndividualSecretsPreflight("id", runner);
    expect(outcome.kind).toBe("missing-strict");
    if (outcome.kind === "missing-strict") {
      expect(outcome.missing).toEqual([
        INTERNAL_SERVICE_SECRET_USER_NAME,
        INTERNAL_SERVICE_SECRET_ADMIN_NAME,
      ]);
    }
    expect(buf.errors[0]).toContain("PREFLIGHT_STRICT=1");
    expect(buf.errors[0]).toContain("aborting deploy");
    expect(buf.errors[0]).toContain(INTERNAL_SERVICE_SECRET_USER_NAME);
    expect(buf.errors[0]).toContain(INTERNAL_SERVICE_SECRET_ADMIN_NAME);
  });

  it("片方未登録 + PREFLIGHT_STRICT=1 でも missing-strict + missing に該当 secret のみ", () => {
    const { runner, buf } = makeRunner({
      env: { PREFLIGHT_STRICT: "1" },
      wrangler: {
        ok: true,
        stdout: JSON.stringify([{ name: INTERNAL_SERVICE_SECRET_ADMIN_NAME }]),
      },
    });
    const outcome = runBffIndividualSecretsPreflight("id", runner);
    expect(outcome.kind).toBe("missing-strict");
    if (outcome.kind === "missing-strict") {
      expect(outcome.missing).toEqual([INTERNAL_SERVICE_SECRET_USER_NAME]);
    }
    expect(buf.errors[0]).toContain(INTERNAL_SERVICE_SECRET_USER_NAME);
    expect(buf.errors[0]).not.toContain(INTERNAL_SERVICE_SECRET_ADMIN_NAME);
  });

  it("PREFLIGHT_STRICT が '1' 以外では strict 扱いせず、設定ミス警告を追加で出す", () => {
    const { runner, buf } = makeRunner({
      env: { PREFLIGHT_STRICT: "true" },
      wrangler: { ok: true, stdout: "[]" },
    });
    const outcome = runBffIndividualSecretsPreflight("id", runner);
    expect(outcome.kind).toBe("missing-warn");
    expect(buf.warns).toHaveLength(2);
    expect(buf.warns[1]).toContain('PREFLIGHT_STRICT="true"');
    expect(buf.warns[1]).toContain("strict mode was NOT applied");
    expect(buf.errors).toHaveLength(0);
  });

  it("SKIP_PREFLIGHT が PREFLIGHT_STRICT=1 より優先される", () => {
    const { runner, buf } = makeRunner({
      env: { SKIP_PREFLIGHT: "1", PREFLIGHT_STRICT: "1" },
      wrangler: { ok: true, stdout: "[]" },
    });
    expect(runBffIndividualSecretsPreflight("id", runner)).toEqual({ kind: "skipped" });
    expect(buf.warns).toHaveLength(0);
    expect(buf.errors).toHaveLength(0);
  });

  it("wrangler が非 0 exit → wrangler-failed を返し fail-open（strict 時も exit しない）", () => {
    const { runner, buf } = makeRunner({
      env: { PREFLIGHT_STRICT: "1" },
      wrangler: { ok: false, exitCode: 1, stderr: "Not logged in" },
    });
    const outcome = runBffIndividualSecretsPreflight("id", runner);
    expect(outcome).toEqual({ kind: "wrangler-failed", exitCode: 1 });
    expect(buf.warns[0]).toContain("wrangler secret list failed");
    expect(buf.warns[0]).toContain("individual BFF secrets");
    expect(buf.warns[1]).toContain("Not logged in");
    expect(buf.errors).toHaveLength(0);
  });

  it("パース不能な stdout → parse-failed を返し警告する", () => {
    const { runner, buf } = makeRunner({
      wrangler: { ok: true, stdout: "not json" },
    });
    const outcome = runBffIndividualSecretsPreflight("id", runner);
    expect(outcome.kind).toBe("parse-failed");
    expect(buf.warns[0]).toContain("could not parse");
    expect(buf.warns[0]).toContain("individual BFF secrets");
  });
});

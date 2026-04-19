import { afterEach, beforeEach, describe, it, expect, vi } from "vite-plus/test";
import { Hono } from "hono";
import type { IdpEnv } from "@0g0-id/shared";

vi.mock("../utils/service-auth", () => ({
  authenticateService: vi.fn(),
}));

import { serviceBindingMiddleware } from "./service-binding";
import { authenticateService } from "../utils/service-auth";

type LogEntry = { level: "info" | "warn" | "error"; ctx: string; msg: string };

function captureLogs(): { entries: LogEntry[]; restore: () => void } {
  const entries: LogEntry[] = [];
  const push = (line: unknown): void => {
    if (typeof line !== "string") return;
    try {
      const parsed = JSON.parse(line) as LogEntry;
      entries.push(parsed);
    } catch {
      // noop: 非 JSON ログは無視
    }
  };
  // vi.spyOn は元の実装を保持したうえで置き換えるため、restore() で正確に元に戻せる。
  // vi.mock(...) で作った service-auth のモジュールモックには影響しない。
  const logSpy = vi.spyOn(console, "log").mockImplementation(push);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(push);
  const errorSpy = vi.spyOn(console, "error").mockImplementation(push);
  return {
    entries,
    restore: () => {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    },
  };
}

function buildApp(env: Partial<IdpEnv>) {
  const app = new Hono<{ Bindings: typeof env }>();
  app.use("/auth/*", serviceBindingMiddleware);
  app.post("/auth/exchange", (c) => c.json({ ok: true }));
  app.post("/auth/refresh", (c) => c.json({ ok: true }));
  return { app, env };
}

const baseUrl = "https://id.0g0.xyz";
const SECRET = "test-internal-secret-12345";

describe("serviceBindingMiddleware", () => {
  describe("INTERNAL_SERVICE_SECRET が未設定の場合", () => {
    it("開発環境（IDP_ORIGIN未設定）ではヘッダーなしでもリクエストを通過させる", async () => {
      const { app, env } = buildApp({});
      const res = await app.request(
        new Request(`${baseUrl}/auth/exchange`, { method: "POST" }),
        undefined,
        env,
      );
      expect(res.status).toBe(200);
    });

    it("本番環境（IDP_ORIGIN=https://）では403を返す", async () => {
      const { app, env } = buildApp({ IDP_ORIGIN: "https://id.0g0.xyz" });
      const res = await app.request(
        new Request(`${baseUrl}/auth/exchange`, { method: "POST" }),
        undefined,
        env,
      );
      expect(res.status).toBe(403);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("FORBIDDEN");
    });

    it("開発環境（IDP_ORIGIN=http://）ではリクエストを通過させる", async () => {
      const { app, env } = buildApp({ IDP_ORIGIN: "http://localhost:8787" });
      const res = await app.request(
        new Request(`${baseUrl}/auth/exchange`, { method: "POST" }),
        undefined,
        env,
      );
      expect(res.status).toBe(200);
    });
  });

  describe("INTERNAL_SERVICE_SECRET が設定されている場合", () => {
    it("正しい X-Internal-Secret ヘッダーで通過する", async () => {
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET: SECRET });
      const res = await app.request(
        new Request(`${baseUrl}/auth/exchange`, {
          method: "POST",
          headers: { "X-Internal-Secret": SECRET },
        }),
        undefined,
        env,
      );
      expect(res.status).toBe(200);
    });

    it("不正な X-Internal-Secret ヘッダーで403を返す", async () => {
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET: SECRET });
      const res = await app.request(
        new Request(`${baseUrl}/auth/exchange`, {
          method: "POST",
          headers: { "X-Internal-Secret": "wrong-secret" },
        }),
        undefined,
        env,
      );
      expect(res.status).toBe(403);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("FORBIDDEN");
    });

    it("ヘッダーなしで403���返す", async () => {
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET: SECRET });
      const res = await app.request(
        new Request(`${baseUrl}/auth/exchange`, { method: "POST" }),
        undefined,
        env,
      );
      expect(res.status).toBe(403);
    });

    it("有効な Authorization: Basic ヘッダーで通過する（サービスOAuth）", async () => {
      vi.mocked(authenticateService).mockResolvedValue({ id: "service-1" } as never);
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET: SECRET, DB: {} as D1Database });
      const res = await app.request(
        new Request(`${baseUrl}/auth/exchange`, {
          method: "POST",
          headers: { Authorization: "Basic dGVzdDp0ZXN0" },
        }),
        undefined,
        env,
      );
      expect(res.status).toBe(200);
      expect(authenticateService).toHaveBeenCalled();
    });

    it("無効な Authorization: Basic ヘッダーでは403を返す", async () => {
      vi.mocked(authenticateService).mockResolvedValue(null);
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET: SECRET, DB: {} as D1Database });
      const res = await app.request(
        new Request(`${baseUrl}/auth/exchange`, {
          method: "POST",
          headers: { Authorization: "Basic aW52YWxpZDppbnZhbGlk" },
        }),
        undefined,
        env,
      );
      expect(res.status).toBe(403);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("FORBIDDEN");
    });

    it("authenticateService がエラーを投げたら500を返す", async () => {
      vi.mocked(authenticateService).mockRejectedValue(new Error("DB error"));
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET: SECRET, DB: {} as D1Database });
      const res = await app.request(
        new Request(`${baseUrl}/auth/exchange`, {
          method: "POST",
          headers: { Authorization: "Basic dGVzdDp0ZXN0" },
        }),
        undefined,
        env,
      );
      expect(res.status).toBe(500);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INTERNAL_ERROR");
    });

    it("Authorization: Bearer ヘッダーでは通過しない", async () => {
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET: SECRET });
      const res = await app.request(
        new Request(`${baseUrl}/auth/exchange`, {
          method: "POST",
          headers: { Authorization: "Bearer some-token" },
        }),
        undefined,
        env,
      );
      expect(res.status).toBe(403);
    });

    it("/auth/refresh にも適用される", async () => {
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET: SECRET });
      const resBlocked = await app.request(
        new Request(`${baseUrl}/auth/refresh`, { method: "POST" }),
        undefined,
        env,
      );
      expect(resBlocked.status).toBe(403);

      const resAllowed = await app.request(
        new Request(`${baseUrl}/auth/refresh`, {
          method: "POST",
          headers: { "X-Internal-Secret": SECRET },
        }),
        undefined,
        env,
      );
      expect(resAllowed.status).toBe(200);
    });
  });

  describe("BFF 毎の個別シークレット（issue #156）", () => {
    const USER_SECRET = "user-bff-secret-abc";
    const ADMIN_SECRET = "admin-bff-secret-xyz";

    it("INTERNAL_SERVICE_SECRET_USER と一致すれば通過する", async () => {
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET_USER: USER_SECRET });
      const res = await app.request(
        new Request(`${baseUrl}/auth/exchange`, {
          method: "POST",
          headers: { "X-Internal-Secret": USER_SECRET },
        }),
        undefined,
        env,
      );
      expect(res.status).toBe(200);
    });

    it("INTERNAL_SERVICE_SECRET_ADMIN と一致すれば通過する", async () => {
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET_ADMIN: ADMIN_SECRET });
      const res = await app.request(
        new Request(`${baseUrl}/auth/exchange`, {
          method: "POST",
          headers: { "X-Internal-Secret": ADMIN_SECRET },
        }),
        undefined,
        env,
      );
      expect(res.status).toBe(200);
    });

    it("どの設定シークレットとも一致しないと 403", async () => {
      const { app, env } = buildApp({
        INTERNAL_SERVICE_SECRET_USER: USER_SECRET,
        INTERNAL_SERVICE_SECRET_ADMIN: ADMIN_SECRET,
      });
      const res = await app.request(
        new Request(`${baseUrl}/auth/exchange`, {
          method: "POST",
          headers: { "X-Internal-Secret": "completely-wrong-secret" },
        }),
        undefined,
        env,
      );
      expect(res.status).toBe(403);
    });

    it("共有 INTERNAL_SERVICE_SECRET と BFF 個別シークレットの併用時、どちらでも通過する（後方互換）", async () => {
      const { app, env } = buildApp({
        INTERNAL_SERVICE_SECRET: SECRET,
        INTERNAL_SERVICE_SECRET_USER: USER_SECRET,
      });
      const resShared = await app.request(
        new Request(`${baseUrl}/auth/exchange`, {
          method: "POST",
          headers: { "X-Internal-Secret": SECRET },
        }),
        undefined,
        env,
      );
      expect(resShared.status).toBe(200);

      const resUser = await app.request(
        new Request(`${baseUrl}/auth/exchange`, {
          method: "POST",
          headers: { "X-Internal-Secret": USER_SECRET },
        }),
        undefined,
        env,
      );
      expect(resUser.status).toBe(200);
    });

    it("個別シークレットのみ設定で本番環境（IDP_ORIGIN=https://）でも 403 にならない", async () => {
      const { app, env } = buildApp({
        IDP_ORIGIN: "https://id.0g0.xyz",
        INTERNAL_SERVICE_SECRET_USER: USER_SECRET,
      });
      const res = await app.request(
        new Request(`${baseUrl}/auth/exchange`, {
          method: "POST",
          headers: { "X-Internal-Secret": USER_SECRET },
        }),
        undefined,
        env,
      );
      expect(res.status).toBe(200);
    });
  });

  describe("observability ログ（issue #156）", () => {
    const USER_SECRET = "user-bff-secret-abc";
    const ADMIN_SECRET = "admin-bff-secret-xyz";
    let logs: ReturnType<typeof captureLogs>;

    beforeEach(() => {
      logs = captureLogs();
    });

    afterEach(() => {
      logs.restore();
    });

    it("USER 個別シークレットで通過した時、kind=user の info ログが記録される", async () => {
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET_USER: USER_SECRET });
      await app.request(
        new Request(`${baseUrl}/auth/exchange`, {
          method: "POST",
          headers: { "X-Internal-Secret": USER_SECRET },
        }),
        undefined,
        env,
      );
      const authLog = logs.entries.find(
        (e) => e.ctx === "service-binding" && e.msg === "internal secret authenticated",
      );
      expect(authLog).toBeDefined();
      expect(authLog?.level).toBe("info");
      const deprecation = logs.entries.find((e) =>
        e.msg.includes("deprecated shared INTERNAL_SERVICE_SECRET"),
      );
      expect(deprecation).toBeUndefined();
    });

    it("ADMIN 個別シークレットで通過しても deprecation 警告は出ない", async () => {
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET_ADMIN: ADMIN_SECRET });
      await app.request(
        new Request(`${baseUrl}/auth/exchange`, {
          method: "POST",
          headers: { "X-Internal-Secret": ADMIN_SECRET },
        }),
        undefined,
        env,
      );
      const deprecation = logs.entries.find((e) =>
        e.msg.includes("deprecated shared INTERNAL_SERVICE_SECRET"),
      );
      expect(deprecation).toBeUndefined();
    });

    it("共有 INTERNAL_SERVICE_SECRET で通過した時、deprecation warn ログが記録される", async () => {
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET: SECRET });
      await app.request(
        new Request(`${baseUrl}/auth/exchange`, {
          method: "POST",
          headers: { "X-Internal-Secret": SECRET },
        }),
        undefined,
        env,
      );
      const deprecation = logs.entries.find((e) =>
        e.msg.includes("deprecated shared INTERNAL_SERVICE_SECRET"),
      );
      expect(deprecation).toBeDefined();
      expect(deprecation?.level).toBe("warn");
    });

    it("ヘッダーあり + 不一致では mismatch warn と access denied warn が記録される", async () => {
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET: SECRET });
      await app.request(
        new Request(`${baseUrl}/auth/exchange`, {
          method: "POST",
          headers: { "X-Internal-Secret": "wrong-secret" },
        }),
        undefined,
        env,
      );
      expect(logs.entries.find((e) => e.msg === "internal secret mismatch")).toBeDefined();
      expect(logs.entries.find((e) => e.msg === "service binding access denied")).toBeDefined();
    });

    it("ヘッダーなし / Basic なしの拒否では mismatch は出ず access denied のみ記録される", async () => {
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET: SECRET });
      await app.request(
        new Request(`${baseUrl}/auth/exchange`, { method: "POST" }),
        undefined,
        env,
      );
      expect(logs.entries.find((e) => e.msg === "internal secret mismatch")).toBeUndefined();
      expect(logs.entries.find((e) => e.msg === "service binding access denied")).toBeDefined();
    });
  });

  describe("Deprecation レスポンスヘッダ（issue #156 / RFC 9745）", () => {
    const USER_SECRET = "user-bff-secret-abc";

    it("共有 INTERNAL_SERVICE_SECRET で通過した時、Deprecation: true と Link rel=deprecation が付与される", async () => {
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET: SECRET });
      const res = await app.request(
        new Request(`${baseUrl}/auth/exchange`, {
          method: "POST",
          headers: { "X-Internal-Secret": SECRET },
        }),
        undefined,
        env,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("Deprecation")).toBe("true");
      expect(res.headers.get("Link")).toContain('rel="deprecation"');
      expect(res.headers.get("Link")).toContain("issues/156");
    });

    it("USER 個別シークレットで通過した時、Deprecation ヘッダは付与されない", async () => {
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET_USER: USER_SECRET });
      const res = await app.request(
        new Request(`${baseUrl}/auth/exchange`, {
          method: "POST",
          headers: { "X-Internal-Secret": USER_SECRET },
        }),
        undefined,
        env,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("Deprecation")).toBeNull();
      expect(res.headers.get("Link")).toBeNull();
    });

    it("Authorization: Basic で通過した時、Deprecation ヘッダは付与されない", async () => {
      vi.mocked(authenticateService).mockResolvedValue({ id: "service-1" } as never);
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET: SECRET, DB: {} as D1Database });
      const res = await app.request(
        new Request(`${baseUrl}/auth/exchange`, {
          method: "POST",
          headers: { Authorization: "Basic dGVzdDp0ZXN0" },
        }),
        undefined,
        env,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("Deprecation")).toBeNull();
      expect(res.headers.get("Link")).toBeNull();
    });
  });

  describe("INTERNAL_SECRET_STRICT モード（issue #156 Phase 6）", () => {
    const USER_SECRET = "user-bff-secret-abc";
    const ADMIN_SECRET = "admin-bff-secret-xyz";
    let logs: ReturnType<typeof captureLogs>;

    beforeEach(() => {
      logs = captureLogs();
    });

    afterEach(() => {
      logs.restore();
    });

    it("strict=true で共有 INTERNAL_SERVICE_SECRET は 403 DEPRECATED_INTERNAL_SECRET で拒否される", async () => {
      const { app, env } = buildApp({
        INTERNAL_SERVICE_SECRET: SECRET,
        INTERNAL_SECRET_STRICT: "true",
      });
      const res = await app.request(
        new Request(`${baseUrl}/auth/exchange`, {
          method: "POST",
          headers: { "X-Internal-Secret": SECRET },
        }),
        undefined,
        env,
      );
      expect(res.status).toBe(403);
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe("DEPRECATED_INTERNAL_SECRET");
      expect(body.error.message).toContain("INTERNAL_SERVICE_SECRET_USER");
    });

    it("strict 拒否レスポンスにも Deprecation / Link ヘッダが付与される（原因特定のため）", async () => {
      const { app, env } = buildApp({
        INTERNAL_SERVICE_SECRET: SECRET,
        INTERNAL_SECRET_STRICT: "true",
      });
      const res = await app.request(
        new Request(`${baseUrl}/auth/exchange`, {
          method: "POST",
          headers: { "X-Internal-Secret": SECRET },
        }),
        undefined,
        env,
      );
      expect(res.headers.get("Deprecation")).toBe("true");
      expect(res.headers.get("Link")).toContain('rel="deprecation"');
      expect(res.headers.get("Link")).toContain("issues/156");
    });

    it("strict 拒否時には error ログ（rejected under INTERNAL_SECRET_STRICT）が記録される", async () => {
      const { app, env } = buildApp({
        INTERNAL_SERVICE_SECRET: SECRET,
        INTERNAL_SECRET_STRICT: "true",
      });
      await app.request(
        new Request(`${baseUrl}/auth/exchange`, {
          method: "POST",
          headers: { "X-Internal-Secret": SECRET },
        }),
        undefined,
        env,
      );
      const rejectLog = logs.entries.find((e) =>
        e.msg.includes("rejected under INTERNAL_SECRET_STRICT"),
      );
      expect(rejectLog).toBeDefined();
      expect(rejectLog?.level).toBe("error");
      // warn-only 経路の deprecation log は出さない（strict では短絡拒否のため）
      expect(
        logs.entries.find((e) =>
          e.msg.includes("deprecated shared INTERNAL_SERVICE_SECRET を使用した"),
        ),
      ).toBeUndefined();
    });

    it("strict=true でも USER 個別シークレットは通過する（影響範囲限定）", async () => {
      const { app, env } = buildApp({
        INTERNAL_SERVICE_SECRET: SECRET,
        INTERNAL_SERVICE_SECRET_USER: USER_SECRET,
        INTERNAL_SECRET_STRICT: "true",
      });
      const res = await app.request(
        new Request(`${baseUrl}/auth/exchange`, {
          method: "POST",
          headers: { "X-Internal-Secret": USER_SECRET },
        }),
        undefined,
        env,
      );
      expect(res.status).toBe(200);
      // USER 経路には Deprecation ヘッダも出ない
      expect(res.headers.get("Deprecation")).toBeNull();
    });

    it("strict=true でも ADMIN 個別シークレットは通過する", async () => {
      const { app, env } = buildApp({
        INTERNAL_SERVICE_SECRET: SECRET,
        INTERNAL_SERVICE_SECRET_ADMIN: ADMIN_SECRET,
        INTERNAL_SECRET_STRICT: "true",
      });
      const res = await app.request(
        new Request(`${baseUrl}/auth/exchange`, {
          method: "POST",
          headers: { "X-Internal-Secret": ADMIN_SECRET },
        }),
        undefined,
        env,
      );
      expect(res.status).toBe(200);
    });

    it("strict=true でも Basic 認証（サービスOAuthクライアント）は通過する", async () => {
      vi.mocked(authenticateService).mockResolvedValue({ id: "service-1" } as never);
      const { app, env } = buildApp({
        INTERNAL_SERVICE_SECRET: SECRET,
        INTERNAL_SECRET_STRICT: "true",
        DB: {} as D1Database,
      });
      const res = await app.request(
        new Request(`${baseUrl}/auth/exchange`, {
          method: "POST",
          headers: { Authorization: "Basic dGVzdDp0ZXN0" },
        }),
        undefined,
        env,
      );
      expect(res.status).toBe(200);
    });

    it("Phase 6 完全移行後（共有シークレット未設定・個別のみ）+ strict=true でも Basic 認証は通る", async () => {
      // 最終形: 共有 INTERNAL_SERVICE_SECRET は削除済み、個別のみ運用、strict も有効化済みの状態で、
      // 外部 OAuth クライアント（Basic 認証）が引き続き通過できることを回帰テストで固定化する。
      vi.mocked(authenticateService).mockResolvedValue({ id: "service-1" } as never);
      const { app, env } = buildApp({
        INTERNAL_SERVICE_SECRET_USER: USER_SECRET,
        INTERNAL_SECRET_STRICT: "true",
        DB: {} as D1Database,
      });
      const res = await app.request(
        new Request(`${baseUrl}/auth/exchange`, {
          method: "POST",
          headers: { Authorization: "Basic dGVzdDp0ZXN0" },
        }),
        undefined,
        env,
      );
      expect(res.status).toBe(200);
    });

    it("strict 拒否 error ログに kind=shared が含まれる（後段フィルタ用）", async () => {
      const { app, env } = buildApp({
        INTERNAL_SERVICE_SECRET: SECRET,
        INTERNAL_SECRET_STRICT: "true",
      });
      await app.request(
        new Request(`${baseUrl}/auth/exchange`, {
          method: "POST",
          headers: { "X-Internal-Secret": SECRET },
        }),
        undefined,
        env,
      );
      const rejectLog = logs.entries.find(
        (e) => e.level === "error" && e.msg.includes("rejected under INTERNAL_SECRET_STRICT"),
      );
      expect(rejectLog).toBeDefined();
      // 構造化ログに kind=shared が乗っていること（SRE が "kind=shared" でフィルタして
      // strict 起因の 403 だけ絞り込めるようにするための不変量）。
      expect(JSON.stringify(rejectLog)).toContain('"kind":"shared"');
    });

    it("strict=false 相当の値（未設定・'1' 等）では従来通り共有シークレットが通過し warn + Deprecation が出る", async () => {
      for (const strictValue of [undefined, "", "1", "yes", "false"]) {
        const { app, env } = buildApp({
          INTERNAL_SERVICE_SECRET: SECRET,
          ...(strictValue !== undefined ? { INTERNAL_SECRET_STRICT: strictValue } : {}),
        });
        const res = await app.request(
          new Request(`${baseUrl}/auth/exchange`, {
            method: "POST",
            headers: { "X-Internal-Secret": SECRET },
          }),
          undefined,
          env,
        );
        expect(res.status).toBe(200);
        expect(res.headers.get("Deprecation")).toBe("true");
      }
    });

    it("strict 受理値は 'true' のみ（'TRUE' / 前後空白も許容 — isInternalSecretStrict と挙動が一致）", async () => {
      for (const strictValue of ["true", "TRUE", "True", "  true  "]) {
        const { app, env } = buildApp({
          INTERNAL_SERVICE_SECRET: SECRET,
          INTERNAL_SECRET_STRICT: strictValue,
        });
        const res = await app.request(
          new Request(`${baseUrl}/auth/exchange`, {
            method: "POST",
            headers: { "X-Internal-Secret": SECRET },
          }),
          undefined,
          env,
        );
        expect(res.status).toBe(403);
        const body = await res.json<{ error: { code: string } }>();
        expect(body.error.code).toBe("DEPRECATED_INTERNAL_SECRET");
      }
    });
  });
});

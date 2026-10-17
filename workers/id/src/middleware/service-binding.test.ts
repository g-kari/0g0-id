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

  describe("INTERNAL_SERVICE_SECRET_USER が設定されている場合", () => {
    it("正しい X-Internal-Secret ヘッダーで通過する", async () => {
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET_USER: SECRET });
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
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET_USER: SECRET });
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

    it("ヘッダーなしで403を返す", async () => {
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET_USER: SECRET });
      const res = await app.request(
        new Request(`${baseUrl}/auth/exchange`, { method: "POST" }),
        undefined,
        env,
      );
      expect(res.status).toBe(403);
    });

    it("有効な Authorization: Basic ヘッダーで通過する（サービスOAuth）", async () => {
      vi.mocked(authenticateService).mockResolvedValue({ id: "service-1" } as never);
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET_USER: SECRET, DB: {} as D1Database });
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
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET_USER: SECRET, DB: {} as D1Database });
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
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET_USER: SECRET, DB: {} as D1Database });
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
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET_USER: SECRET });
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
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET_USER: SECRET });
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

    it("ヘッダーあり + 不一致では mismatch warn と access denied warn が記録される", async () => {
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET_USER: SECRET });
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
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET_USER: SECRET });
      await app.request(
        new Request(`${baseUrl}/auth/exchange`, { method: "POST" }),
        undefined,
        env,
      );
      expect(logs.entries.find((e) => e.msg === "internal secret mismatch")).toBeUndefined();
      expect(logs.entries.find((e) => e.msg === "service binding access denied")).toBeDefined();
    });
  });
});

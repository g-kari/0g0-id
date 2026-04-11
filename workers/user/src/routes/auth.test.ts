import { describe, it, expect, vi } from "vite-plus/test";
import { encodeSession } from "@0g0-id/shared";
import { Hono } from "hono";

import authRoutes from "./auth";

const SESSION_COOKIE = "__Host-user-session";
const STATE_COOKIE = "__Host-user-oauth-state";
const baseUrl = "https://user.0g0.xyz";

function buildApp(idpFetch: (req: Request) => Promise<Response>) {
  const app = new Hono<{
    Bindings: { IDP: { fetch: typeof idpFetch }; IDP_ORIGIN: string; SESSION_SECRET: string };
  }>();
  app.route("/auth", authRoutes);
  return {
    request: (path: string, init?: RequestInit) => {
      const req = new Request(`${baseUrl}${path}`, init);
      return app.request(req, undefined, {
        IDP: { fetch: idpFetch },
        IDP_ORIGIN: "https://id.0g0.xyz",
        SESSION_SECRET: "test-secret",
      });
    },
  };
}

async function makeSessionCookie(userId = "user-123"): Promise<string> {
  const session = {
    access_token: "mock-access-token",
    refresh_token: "mock-refresh-token",
    user: { id: userId, email: "user@example.com", name: "Test User", role: "user" as const },
  };
  return encodeSession(session, "test-secret");
}

describe("user BFF — /auth", () => {
  describe("GET /login — OAuthログイン開始", () => {
    it("デフォルトプロバイダー（google）でIdPへリダイレクトする", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/auth/login");

      expect(res.status).toBe(302);
      const location = res.headers.get("Location") ?? "";
      expect(location).toContain("https://id.0g0.xyz/auth/login");
      expect(location).toContain("provider=google");
      expect(location).toContain("redirect_to=");
    });

    it("指定したプロバイダーでIdPへリダイレクトする", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      for (const provider of ["google", "line", "twitch", "github", "x"]) {
        const res = await app.request(`/auth/login?provider=${provider}`);
        expect(res.status).toBe(302);
        expect(res.headers.get("Location")).toContain(`provider=${provider}`);
      }
    });

    it("不正なプロバイダーで /?error=invalid_provider にリダイレクトする", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/auth/login?provider=invalid");

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/?error=invalid_provider");
    });

    it("stateクエリパラメータをIdPのURLに含める", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/auth/login");

      const location = res.headers.get("Location") ?? "";
      const url = new URL(location);
      expect(url.searchParams.get("state")).toBeTruthy();
    });

    it("IdPは呼び出さない", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      await app.request("/auth/login");

      expect(idpFetch).not.toHaveBeenCalled();
    });
  });

  describe("GET /callback — OAuthコールバック", () => {
    it("codeまたはstateが欠けている場合は /?error=missing_params にリダイレクトする", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const resNoCode = await app.request("/auth/callback?state=abc");
      expect(resNoCode.status).toBe(302);
      expect(resNoCode.headers.get("Location")).toBe("/?error=missing_params");

      const resNoState = await app.request("/auth/callback?code=abc");
      expect(resNoState.status).toBe(302);
      expect(resNoState.headers.get("Location")).toBe("/?error=missing_params");
    });

    it("stateCookieがない場合は /?error=missing_session にリダイレクトする", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/auth/callback?code=testcode&state=teststate");

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/?error=missing_session");
    });

    it("stateが一致しない場合は /?error=state_mismatch にリダイレクトする", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/auth/callback?code=testcode&state=wrong-state", {
        headers: { Cookie: `${STATE_COOKIE}=correct-state` },
      });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/?error=state_mismatch");
    });

    it("コード交換が失敗した場合は /?error=exchange_failed にリダイレクトする", async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 400 }));
      const app = buildApp(idpFetch);

      const res = await app.request("/auth/callback?code=testcode&state=teststate", {
        headers: { Cookie: `${STATE_COOKIE}=teststate` },
      });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/?error=exchange_failed");
    });

    it("コード交換成功時にセッションCookieを設定して /profile.html にリダイレクトする", async () => {
      const exchangeData = {
        data: {
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          user: { id: "user-123", email: "user@example.com", name: "Test User", role: "user" },
        },
      };
      const idpFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(exchangeData), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const app = buildApp(idpFetch);

      const res = await app.request("/auth/callback?code=testcode&state=teststate", {
        headers: { Cookie: `${STATE_COOKIE}=teststate` },
      });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/profile.html");

      const setCookieHeader = res.headers.get("Set-Cookie") ?? "";
      expect(setCookieHeader).toContain(SESSION_COOKIE);
    });

    it("コード交換時にIdPの /auth/exchange エンドポイントを呼び出す", async () => {
      const exchangeData = {
        data: {
          access_token: "token",
          refresh_token: "refresh",
          user: { id: "u1", email: "e@e.com", name: "N", role: "user" },
        },
      };
      const idpFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(exchangeData), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const app = buildApp(idpFetch);

      await app.request("/auth/callback?code=mycode&state=mystate", {
        headers: { Cookie: `${STATE_COOKIE}=mystate` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.method).toBe("POST");
      expect(calledReq.url).toBe("https://id.0g0.xyz/auth/exchange");
    });
  });

  describe("POST /logout — ログアウト", () => {
    it("セッションなしでも / にリダイレクトする", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/auth/logout", { method: "POST" });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/");
    });

    it("セッションがある場合はIdPのlogoutを呼び出してCookieを削除する", async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      const res = await app.request("/auth/logout", {
        method: "POST",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/");
      expect(idpFetch).toHaveBeenCalledTimes(1);

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.url).toBe("https://id.0g0.xyz/auth/logout");
      expect(calledReq.method).toBe("POST");
    });

    it("IdPのlogoutが失敗してもCookieを削除して / にリダイレクトする", async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
      const app = buildApp(idpFetch);

      const res = await app.request("/auth/logout", {
        method: "POST",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/");
    });
  });

  describe("POST /link — SNSプロバイダー連携開始", () => {
    it("セッションなしで /?error=not_authenticated にリダイレクトする", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/auth/link?provider=github", { method: "POST" });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/?error=not_authenticated");
    });

    it("不正なプロバイダーで /profile.html?error=invalid_provider にリダイレクトする", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/auth/link?provider=invalid", {
        method: "POST",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/profile.html?error=invalid_provider");
    });

    it("link-intentエンドポイントを呼び出してlink_tokenをIdPのURLに含める", async () => {
      const linkIntentData = { data: { link_token: "mock-one-time-link-token" } };
      const idpFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(linkIntentData), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const app = buildApp(idpFetch);

      const res = await app.request("/auth/link?provider=github", {
        method: "POST",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie("user-abc")}` },
      });

      expect(res.status).toBe(302);
      // IdPの /auth/link-intent を呼び出したことを確認
      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.url).toBe("https://id.0g0.xyz/auth/link-intent");
      expect(calledReq.method).toBe("POST");
      expect(calledReq.headers.get("Authorization")).toBe("Bearer mock-access-token");
      // リダイレクトURLにlink_tokenが含まれ、link_user_idは含まれないことを確認
      const location = res.headers.get("Location") ?? "";
      expect(location).toContain("https://id.0g0.xyz/auth/login");
      expect(location).toContain("provider=github");
      expect(location).toContain("link_token=mock-one-time-link-token");
      expect(location).not.toContain("link_user_id");
    });

    it("link-intent呼び出し失敗時に /profile.html?error=link_failed にリダイレクトする", async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
      const app = buildApp(idpFetch);

      const res = await app.request("/auth/link?provider=github", {
        method: "POST",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/profile.html?error=link_failed");
    });

    it("stateクエリパラメータをIdPのURLに含める", async () => {
      const linkIntentData = { data: { link_token: "mock-link-token" } };
      const idpFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(linkIntentData), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const app = buildApp(idpFetch);

      const res = await app.request("/auth/link?provider=google", {
        method: "POST",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const location = res.headers.get("Location") ?? "";
      const url = new URL(location);
      expect(url.searchParams.get("state")).toBeTruthy();
    });
  });
});

import { Hono } from "hono";
import { getCookie, deleteCookie } from "hono/cookie";
import type { BffEnv } from "../types";
import { generateToken } from "./crypto";
import {
  parseSession,
  setSessionCookie,
  exchangeCodeAtIdp,
  revokeTokenAtIdp,
  SESSION_COOKIE_DELETE_OPTIONS,
} from "./bff";
import { setOAuthStateCookie, verifyAndConsumeOAuthState } from "./bff";
import { createLogger } from "./logger";
import type { ExchangeResult } from "./bff";
import { buildSecureSessionRegistrationHeader } from "./dbsc";

/** ファクトリに渡す設定 */
export interface BffAuthConfig {
  /** セッションCookie名（例: "__Host-admin-session"） */
  sessionCookieName: string;
  /** OAuth state Cookie名（例: "__Host-admin-oauth-state"） */
  stateCookieName: string;
  /** ロガー名（例: "admin-auth"） */
  loggerName: string;
  /** ログイン成功後のリダイレクト先（例: "/dashboard"） */
  successRedirect: string;
  /** login URLに追加するパラメータを返す。Responseを返すとそこで中断（バリデーションエラー等） */
  loginParams?: (c: {
    req: { query: (key: string) => string | undefined };
    redirect: (url: string) => Response;
  }) => Record<string, string> | Response;
  /** callback時の追加チェック。リダイレクトResponseを返すとそこで中断 */
  onCallbackCheck?: (
    c: { redirect: (url: string) => Response; env: BffEnv },
    result: ExchangeResult,
  ) => Promise<Response | null>;
  /**
   * DBSC (Device Bound Session Credentials) 登録エンドポイントのパス。
   * 設定すると callback 成功応答に Secure-Session-Registration ヘッダを付与し、
   * 対応ブラウザ（Chrome）に DBSC 登録フローを開始させる。
   */
  dbscRegistrationPath?: string;
}

/** BFF認証ルート（login / callback / logout）を生成するファクトリ */
export function createBffAuthRoutes(config: BffAuthConfig) {
  const app = new Hono<{ Bindings: BffEnv }>();
  const logger = createLogger(config.loggerName);

  // GET /auth/login
  app.get("/login", async (c) => {
    const state = generateToken(16);
    const callbackUrl = `${c.env.SELF_ORIGIN}/auth/callback`;

    setOAuthStateCookie(c, config.stateCookieName, state);

    const loginUrl = new URL(`${c.env.IDP_ORIGIN}/auth/login`);
    loginUrl.searchParams.set("redirect_to", callbackUrl);
    loginUrl.searchParams.set("state", state);

    // 追加パラメータ（provider等）
    if (config.loginParams) {
      const paramsOrResponse = config.loginParams(c);
      if (paramsOrResponse instanceof Response) {
        return paramsOrResponse;
      }
      for (const [key, value] of Object.entries(paramsOrResponse)) {
        loginUrl.searchParams.set(key, value);
      }
    }

    return c.redirect(loginUrl.toString());
  });

  // GET /auth/callback
  app.get("/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");

    if (!code || !state) {
      return c.redirect("/?error=missing_params");
    }

    const stateError = verifyAndConsumeOAuthState(c, config.stateCookieName, state);
    if (stateError) {
      return c.redirect(`/?error=${stateError}`);
    }

    const callbackUrl = `${c.env.SELF_ORIGIN}/auth/callback`;
    const result = await exchangeCodeAtIdp(c.env, code, callbackUrl);

    if (!result.ok) {
      return c.redirect("/?error=exchange_failed");
    }

    // 追加チェック（admin role検証等）
    if (config.onCallbackCheck) {
      const checkResult = await config.onCallbackCheck(c, result.data);
      if (checkResult) {
        return checkResult;
      }
    }

    // IdP /auth/exchange は BFF フロー時に必ず session_id を返す仕様。
    // 未返却は IdP 側の不整合（例: バージョン不一致）なのでセッション確立を拒否する。
    if (!result.data.session_id) {
      logger.error("[callback] IdP did not return session_id for BFF flow");
      return c.redirect("/?error=exchange_failed");
    }

    await setSessionCookie(c, config.sessionCookieName, {
      session_id: result.data.session_id,
      access_token: result.data.access_token,
      refresh_token: result.data.refresh_token,
      user: result.data.user,
    });

    if (config.dbscRegistrationPath) {
      // Chrome 等の対応ブラウザに DBSC 登録フローを開始させる。
      // 値の文法は draft 仕様に従い `(<algs>);path="<path>"` 形式とする。
      c.header(
        "Secure-Session-Registration",
        buildSecureSessionRegistrationHeader({ path: config.dbscRegistrationPath }),
      );
    }

    return c.redirect(config.successRedirect);
  });

  // POST /auth/logout
  app.post("/logout", async (c) => {
    const sessionData = await parseSession(
      getCookie(c, config.sessionCookieName),
      c.env.SESSION_SECRET,
    );
    if (sessionData) {
      try {
        await revokeTokenAtIdp(c.env, sessionData.refresh_token, sessionData.session_id);
      } catch (err) {
        logger.error("[logout] IdP revoke request failed", err);
      }
    }

    deleteCookie(c, config.sessionCookieName, SESSION_COOKIE_DELETE_OPTIONS);
    return c.redirect("/");
  });

  return app;
}

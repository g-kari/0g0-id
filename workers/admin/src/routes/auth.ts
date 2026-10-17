import { createBffAuthRoutes, revokeTokenAtIdp, createLogger, COOKIE_NAMES } from "@0g0-id/shared";

const adminAuthLogger = createLogger("admin-auth");

const SESSION_COOKIE = COOKIE_NAMES.ADMIN_SESSION;

const app = createBffAuthRoutes({
  sessionCookieName: SESSION_COOKIE,
  stateCookieName: COOKIE_NAMES.ADMIN_STATE,
  loggerName: "admin-auth",
  successRedirect: "/dashboard",
  // Chrome 等の DBSC 対応ブラウザに端末バインド登録フローを開始させる
  dbscRegistrationPath: "/auth/dbsc/start",
  onCallbackCheck: async (c, result) => {
    if (result.user.role !== "admin") {
      // 非管理者ユーザーのリフレッシュトークンを失効させる（孤立トークン防止）
      try {
        await revokeTokenAtIdp(c.env, result.refresh_token);
      } catch (err) {
        adminAuthLogger.warn("[admin-callback] IdP logout request failed for non-admin user", err);
      }
      return c.redirect("/?error=not_admin");
    }
    return null;
  },
});

export default app;

import { createBffDbscRoutes, COOKIE_NAMES } from "@0g0-id/shared";

// user BFF の DBSC ルート。実装は packages/shared の共通 factory に集約されている。
// 差分（Cookie 名・logger 名）のみを config で注入する。
const app = createBffDbscRoutes({
  sessionCookieName: COOKIE_NAMES.USER_SESSION,
  loggerName: "user-dbsc",
  credentialsCookieName: COOKIE_NAMES.USER_SESSION,
});

export default app;

import { createBffDbscRoutes } from "@0g0-id/shared";
import { SESSION_COOKIE } from "./auth";

// admin BFF の DBSC ルート。実装は packages/shared の共通 factory に集約されている。
// 差分（Cookie 名・logger 名）のみを config で注入する。
const app = createBffDbscRoutes({
  sessionCookieName: SESSION_COOKIE,
  loggerName: "admin-dbsc",
  credentialsCookieName: "__Host-admin-session",
});

export default app;

import { Hono } from "hono";
import type { IdpEnv } from "@0g0-id/shared";
import type { Variables } from "./_shared";
import adminDetailRoutes from "./admin-detail";
import adminAuthControlRoutes from "./admin-auth-control";
import adminSessionsRoutes from "./admin-sessions";
import adminLockoutRoutes from "./admin-lockout";

const app = new Hono<{ Bindings: IdpEnv; Variables: Variables }>();

app.route("/", adminDetailRoutes);
app.route("/", adminAuthControlRoutes);
app.route("/", adminSessionsRoutes);
app.route("/", adminLockoutRoutes);

export default app;

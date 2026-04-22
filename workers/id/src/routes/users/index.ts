import { Hono } from "hono";
import { uuidParamMiddleware } from "@0g0-id/shared";
import type { IdpEnv } from "@0g0-id/shared";
import type { Variables } from "./_shared";
import meRoutes from "./me";
import adminRoutes from "./admin";

const app = new Hono<{ Bindings: IdpEnv; Variables: Variables }>();

app.use("/:id", uuidParamMiddleware("id", { allowValues: ["me"], label: "user ID" }));
app.use("/:id/*", uuidParamMiddleware("id", { allowValues: ["me"], label: "user ID" }));

app.route("/", meRoutes);
app.route("/", adminRoutes);

export default app;

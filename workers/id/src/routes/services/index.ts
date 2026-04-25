import { Hono } from "hono";
import { uuidParamMiddleware } from "@0g0-id/shared";
import type { ServiceAppEnv } from "./_shared";
import crudRoutes from "./crud";
import redirectUriRoutes from "./redirect-uris";
import adminOperationsRoutes from "./admin-operations";

const app = new Hono<ServiceAppEnv>();

// サービスID形式検証ミドルウェア（:id パラメータを持つすべてのルートに適用）
app.use("/:id", uuidParamMiddleware("id", { label: "service ID" }));
app.use("/:id/*", uuidParamMiddleware("id", { label: "service ID" }));

// ルート組み立て
app.route("/", crudRoutes);
app.route("/", redirectUriRoutes);
app.route("/", adminOperationsRoutes);

export default app;

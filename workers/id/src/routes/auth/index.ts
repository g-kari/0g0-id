import { Hono } from "hono";
import type { IdpEnv, TokenPayload } from "@0g0-id/shared";
import { authRateLimitMiddleware, tokenApiRateLimitMiddleware } from "../../middleware/rate-limit";
import {
  authMiddleware,
  rejectServiceTokenMiddleware,
  rejectBannedUserMiddleware,
} from "../../middleware/auth";
import { serviceBindingMiddleware } from "../../middleware/service-binding";

import { handleAuthorize } from "./authorize";
import { handleLogin } from "./login";
import { handleCallback } from "./callback";
import { handleExchange } from "./exchange";
import { handleRefresh } from "./refresh";
import { handleLinkIntent } from "./link-intent";
import { handleLogout } from "./logout";
import { handleDbscBind, handleDbscChallenge, handleDbscVerify, handleDbscStatus } from "./dbsc";

type Variables = { user: TokenPayload };

const app = new Hono<{ Bindings: IdpEnv; Variables: Variables }>();

// GET /auth/authorize — 標準 OAuth 2.0 Authorization エンドポイント
app.get("/authorize", authRateLimitMiddleware, handleAuthorize);

// GET /auth/login — BFFからのリダイレクト受け取り + プロバイダー認可へリダイレクト
app.get("/login", authRateLimitMiddleware, handleLogin);

// GET /auth/callback — OAuthコールバック（全プロバイダー共通）
app.get("/callback", authRateLimitMiddleware, handleCallback);

// POST /auth/exchange — ワンタイムコード交換
app.post("/exchange", tokenApiRateLimitMiddleware, serviceBindingMiddleware, handleExchange);

// POST /auth/refresh — トークンリフレッシュ（BFFサーバー間専用）
app.post("/refresh", tokenApiRateLimitMiddleware, serviceBindingMiddleware, handleRefresh);

// POST /auth/link-intent — SNSプロバイダー連携用ワンタイムトークン発行
app.post(
  "/link-intent",
  tokenApiRateLimitMiddleware,
  authMiddleware,
  rejectServiceTokenMiddleware,
  rejectBannedUserMiddleware,
  handleLinkIntent,
);

// POST /auth/logout — ログアウト（BFFサーバー間専用）
app.post("/logout", tokenApiRateLimitMiddleware, serviceBindingMiddleware, handleLogout);

// POST /auth/dbsc/bind — DBSC 端末公開鍵バインド（BFFサーバー間専用）
app.post("/dbsc/bind", tokenApiRateLimitMiddleware, serviceBindingMiddleware, handleDbscBind);

// POST /auth/dbsc/challenge — DBSC リフレッシュ用 nonce 発行（BFFサーバー間専用）
app.post(
  "/dbsc/challenge",
  tokenApiRateLimitMiddleware,
  serviceBindingMiddleware,
  handleDbscChallenge,
);

// POST /auth/dbsc/verify — DBSC proof JWT 検証（BFFサーバー間専用）
app.post("/dbsc/verify", tokenApiRateLimitMiddleware, serviceBindingMiddleware, handleDbscVerify);

// POST /auth/dbsc/status — BFF セッションの端末バインド状態取得（BFFサーバー間専用）
app.post("/dbsc/status", tokenApiRateLimitMiddleware, serviceBindingMiddleware, handleDbscStatus);

export default app;

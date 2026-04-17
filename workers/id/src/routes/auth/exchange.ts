import type { Context } from "hono";
import { z } from "zod";
import type { IdpEnv, Service, TokenPayload } from "@0g0-id/shared";
import {
  parseJsonBody,
  sha256,
  findAndConsumeAuthCode,
  findUserById,
  generateCodeChallenge,
  timingSafeEqual,
  generatePairwiseSub,
  signIdToken,
  createLogger,
  createBffSession,
  BFF_SESSION_MAX_AGE_SECONDS,
} from "@0g0-id/shared";
import { authenticateService } from "../../utils/service-auth";
import { resolveEffectiveScope } from "../../utils/scopes";
import { issueTokenPair, ACCESS_TOKEN_TTL_SECONDS } from "../../utils/token-pair";

const authLogger = createLogger("auth");

const ExchangeSchema = z.object({
  code: z.string().min(1, "code is required"),
  redirect_to: z.string().min(1, "redirect_to is required").max(2048, "redirect_to too long"),
  code_verifier: z
    .string()
    .min(43)
    .max(128)
    .regex(/^[A-Za-z0-9\-._~]+$/, "Invalid code_verifier characters")
    .optional(),
});

type Variables = { user: TokenPayload };

/**
 * POST /auth/exchange — ワンタイムコード交換
 * BFF（service_id なし）および外部サービス（service_id あり）の両方をサポート
 */
export async function handleExchange(c: Context<{ Bindings: IdpEnv; Variables: Variables }>) {
  const result = await parseJsonBody(c, ExchangeSchema);
  if (!result.ok) return result.response;
  const body = result.data;

  const codeHash = await sha256(body.code);
  const authCode = await findAndConsumeAuthCode(c.env.DB, codeHash);

  if (!authCode) {
    return c.json({ error: { code: "INVALID_CODE", message: "Invalid or expired code" } }, 400);
  }

  // redirect_to の一致検証（認可コード横取り攻撃対策）
  if (authCode.redirect_to !== body.redirect_to) {
    return c.json({ error: { code: "INVALID_CODE", message: "redirect_to mismatch" } }, 400);
  }

  // 下流 PKCE 検証（RFC 7636 / OAuth 2.1）
  if (authCode.code_challenge) {
    if (!body.code_verifier) {
      return c.json({ error: { code: "INVALID_CODE", message: "code_verifier is required" } }, 400);
    }
    const expectedChallenge = await generateCodeChallenge(body.code_verifier);
    if (!timingSafeEqual(expectedChallenge, authCode.code_challenge)) {
      return c.json({ error: { code: "INVALID_CODE", message: "code_verifier mismatch" } }, 400);
    }
  }

  // ユーザー情報取得
  const user = await findUserById(c.env.DB, authCode.user_id);
  if (!user) {
    return c.json({ error: { code: "NOT_FOUND", message: "User not found" } }, 404);
  }

  // BANされたユーザーのトークン発行を拒否
  if (user.banned_at !== null) {
    return c.json(
      { error: { code: "ACCOUNT_BANNED", message: "Your account has been suspended" } },
      403,
    );
  }

  // サービスOAuthフロー: service_id が設定されている場合はクライアント認証を要求
  let serviceId: string | null = null;
  let idTokenSub: string = user.id;
  let idTokenAud: string = c.env.IDP_ORIGIN;
  let serviceScope: string | undefined = undefined;

  if (authCode.service_id !== null) {
    // Authorization: Basic <base64(client_id:client_secret)> を検証
    let service: Service | null;
    try {
      service = await authenticateService(c.env.DB, c.req.header("Authorization"));
    } catch (err) {
      authLogger.error("[exchange] Failed to authenticate service", err);
      return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
    }
    // service_id の一致確認（認可コードが別サービス向けであれば拒否）
    if (!service || service.id !== authCode.service_id) {
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Invalid client credentials" } },
        401,
      );
    }

    serviceId = service.id;
    // ペアワイズ sub（OIDC Core 1.0 §8.1）: sha256(client_id:user_id)
    idTokenSub = await generatePairwiseSub(service.client_id, user.id);
    idTokenAud = service.client_id;
    // サービストークンのスコープ: 要求スコープとサービスの allowed_scopes を交差検証
    serviceScope = resolveEffectiveScope(authCode.scope, service.allowed_scopes);
    if (serviceScope === undefined) {
      return c.json({ error: { code: "INVALID_SCOPE", message: "No valid scope" } }, 400);
    }
  }

  // アクセストークン・リフレッシュトークン発行
  const { accessToken, refreshToken: refreshTokenRaw } = await issueTokenPair(
    c.env.DB,
    c.env,
    user,
    {
      serviceId,
      clientId: authCode.service_id !== null ? idTokenAud : undefined,
      scope: serviceScope,
    },
  );

  // OIDC ID トークン発行（OpenID Connect Core 1.0）
  // openid スコープがある場合（またはBFFフローでスコープ未指定）のみ発行
  const shouldIssueIdToken = !serviceScope || serviceScope.split(" ").includes("openid");
  let idToken: string | undefined;
  if (shouldIssueIdToken) {
    const authTime = Math.floor(Date.now() / 1000);
    idToken = await signIdToken(
      {
        iss: c.env.IDP_ORIGIN,
        sub: idTokenSub,
        aud: idTokenAud,
        email: user.email,
        name: user.name,
        picture: user.picture,
        authTime,
        nonce: authCode.nonce ?? undefined,
        // RFC 8176: 認証方式リスト。ソーシャルログインのプロバイダーを記録する
        amr: authCode.provider ? [authCode.provider] : undefined,
      },
      c.env.JWT_PRIVATE_KEY,
      c.env.JWT_PUBLIC_KEY,
    );
  }

  // BFF フロー（service_id なし）の場合は bff_sessions に行を作成して session_id を返す。
  // Cookie 漏洩時のリモート失効（issue #139）用。
  let bffSessionId: string | undefined;
  if (serviceId === null) {
    try {
      bffSessionId = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);
      const bffOrigin = new URL(body.redirect_to).origin;
      await createBffSession(c.env.DB, {
        id: bffSessionId,
        userId: user.id,
        expiresAt: now + BFF_SESSION_MAX_AGE_SECONDS,
        bffOrigin,
        userAgent: c.req.header("User-Agent") ?? null,
        ip: c.req.header("CF-Connecting-IP") ?? null,
      });
    } catch (err) {
      authLogger.error("[exchange] Failed to create bff_session", err);
      return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
    }
  }

  return c.json({
    data: {
      access_token: accessToken,
      ...(idToken ? { id_token: idToken } : {}),
      refresh_token: refreshTokenRaw,
      ...(bffSessionId ? { session_id: bffSessionId } : {}),
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      user: {
        id: idTokenSub,
        email: user.email,
        name: user.name,
        picture: user.picture,
        ...(serviceId === null ? { role: user.role } : {}),
      },
    },
  });
}

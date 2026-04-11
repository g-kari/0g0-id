import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import { parseJsonBody } from "@0g0-id/shared";
import { authenticateService } from "../utils/service-auth";
import { getClientIp } from "../utils/ip";

import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  fetchGoogleUserInfo,
  buildLineAuthUrl,
  exchangeLineCode,
  fetchLineUserInfo,
  buildTwitchAuthUrl,
  exchangeTwitchCode,
  fetchTwitchUserInfo,
  buildGithubAuthUrl,
  exchangeGithubCode,
  fetchGithubUserInfo,
  fetchGithubPrimaryEmail,
  buildXAuthUrl,
  exchangeXCode,
  fetchXUserInfo,
  generateCodeVerifier,
  generateCodeChallenge,
  generateToken,
  sha256,
  signIdToken,
  findRefreshTokenByHash,
  findUserById,
  revokeRefreshToken,
  upsertUser,
  upsertLineUser,
  upsertTwitchUser,
  upsertGithubUser,
  upsertXUser,
  tryBootstrapAdmin,
  createAuthCode,
  findAndConsumeAuthCode,
  findServiceByClientId,
  findServiceById,
  listRedirectUris,
  normalizeRedirectUri,
  timingSafeEqual,
  linkProvider,
  insertLoginEvent,
  createLogger,
  matchRedirectUri,
  signCookie,
  verifyCookie,
  verifyAccessToken,
  addRevokedAccessToken,
} from "@0g0-id/shared";
import type { IdpEnv, TokenPayload, User, OAuthStateCookieData } from "@0g0-id/shared";
import {
  type OAuthProvider,
  PROVIDER_DISPLAY_NAMES,
  ALL_PROVIDERS,
  isValidProvider,
  PROVIDER_CREDENTIALS,
} from "@0g0-id/shared";
import { authRateLimitMiddleware, tokenApiRateLimitMiddleware } from "../middleware/rate-limit";
import {
  authMiddleware,
  rejectServiceTokenMiddleware,
  rejectBannedUserMiddleware,
} from "../middleware/auth";
import { serviceBindingMiddleware } from "../middleware/service-binding";
import { resolveEffectiveScope, validateNonce, validateCodeChallenge } from "../utils/scopes";
import { issueTokenPair, ACCESS_TOKEN_TTL_SECONDS } from "../utils/token-pair";
import {
  validateAndRevokeRefreshToken,
  issueTokenPairWithRecovery,
} from "../utils/refresh-token-rotation";
import { parse as parseDomain } from "tldts";

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

const RefreshSchema = z.object({
  refresh_token: z.string().min(1, "refresh_token is required"),
});

const LogoutSchema = z.object({
  refresh_token: z.string().optional(),
});

type Variables = { user: TokenPayload };

const app = new Hono<{ Bindings: IdpEnv; Variables: Variables }>();

const authLogger = createLogger("auth");

const CALLBACK_PATH = "/auth/callback";

/**
 * OAuthプロバイダーから返されるエラーコードの安全なマッピング。
 * 未知のエラーコードはフォールバックメッセージに置き換え、
 * プロバイダーの内部情報をそのまま反射することを防ぐ。
 */
const OAUTH_ERROR_MAP: Record<string, string> = {
  access_denied: "Access was denied",
  server_error: "Authorization server error",
  temporarily_unavailable: "Authorization server temporarily unavailable",
  invalid_request: "Invalid request",
  unsupported_response_type: "Unsupported response type",
  invalid_scope: "Invalid scope requested",
  interaction_required: "User interaction required",
  login_required: "Login required",
  consent_required: "User consent required",
  account_selection_required: "Account selection required",
};

// state/PKCE保存用Cookie名
const STATE_COOKIE = "__Host-oauth-state";
const PKCE_COOKIE = "__Host-oauth-pkce";

/** プロバイダー認証の解決結果 */
type ProviderResolution =
  | { ok: true; sub: string; upsert: (db: D1Database, id: string) => Promise<User> }
  | { ok: false; response: Response };

/**
 * redirect_to が許可されたオリジンかどうかを検証する。
 *
 * 許可条件（いずれかを満たせばOK）:
 * 1. IDP_ORIGIN のホスト名から第1ラベルを除いた「親ドメイン」（例: id.0g0.xyz → 0g0.xyz）配下の
 *    サブドメイン、または親ドメイン自身（例: *.0g0.xyz, 0g0.xyz）
 * 2. EXTRA_BFF_ORIGINS（カンマ区切り）に一致するオリジン
 *
 * ❌ http:// は拒否（HTTPS必須）
 */
/**
 * EXTRA_BFF_ORIGINS（カンマ区切り文字列）をパースし、
 * redirectUrl のオリジンがそのいずれかと一致するか確認する。
 */
function matchesExtraBffOrigins(redirectUrl: URL, extraBffOrigins?: string): boolean {
  if (!extraBffOrigins) return false;
  return extraBffOrigins
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
    .some((extra) => {
      try {
        return redirectUrl.origin === new URL(extra).origin;
      } catch {
        return false;
      }
    });
}

export function isAllowedRedirectTo(
  redirectTo: string,
  idpOrigin: string,
  extraBffOrigins?: string,
): boolean {
  let redirectUrl: URL;
  try {
    redirectUrl = new URL(redirectTo);
  } catch {
    return false;
  }

  // HTTPS のみ許可
  if (redirectUrl.protocol !== "https:") return false;

  // IDP_ORIGIN から登録可能ドメインを導出して同一登録ドメインを許可
  try {
    const idpUrl = new URL(idpOrigin);
    const idpHostname = idpUrl.hostname;

    // IPアドレス（IPv4 / IPv6）の場合は親ドメイン導出をスキップ
    // 例: 127.0.0.1 → '0.0.1' のような不正なドメインマッチを防ぐ
    // 開発環境でIPを使う場合は EXTRA_BFF_ORIGINS を使用すること
    const isIp =
      /^\d+\.\d+\.\d+\.\d+$/.test(idpHostname) || // IPv4
      (idpHostname.startsWith("[") && idpHostname.endsWith("]")); // IPv6 (URL仕様上 [] で囲まれる)

    if (!isIp) {
      // Public Suffix List を使って登録可能ドメイン (registrable domain) を比較
      // allowPrivateDomains: true で github.io・amazonaws.com 等の private PSL エントリも考慮
      // 例: id.0g0.xyz → 0g0.xyz、user.0g0.xyz → 0g0.xyz（同一なので許可）
      // 例: evil.github.io → evil.github.io（github.io は PSL private suffix）
      const pslOpts = { allowPrivateDomains: true };
      const idpParsed = parseDomain(idpHostname, pslOpts);
      const redirectParsed = parseDomain(redirectUrl.hostname, pslOpts);
      const idpRegistrable = idpParsed.domain; // e.g., "0g0.xyz"
      const redirectRegistrable = redirectParsed.domain; // e.g., "0g0.xyz" or "evil.com"

      if (idpRegistrable && redirectRegistrable && idpRegistrable === redirectRegistrable) {
        return true;
      }
    }
  } catch {
    // ignore — fallthrough to EXTRA_BFF_ORIGINS
  }

  // EXTRA_BFF_ORIGINS による追加オリジン（外部ドメイン向け）
  return matchesExtraBffOrigins(redirectUrl, extraBffOrigins);
}

/**
 * redirect_to が既知のBFFオリジン（USER_ORIGIN / ADMIN_ORIGIN / EXTRA_BFF_ORIGINS）と
 * 完全一致するかを検証する。
 * isAllowedRedirectTo と異なり、*.0g0.xyz のようなワイルドカードマッチは行わない。
 */
export function isBffOrigin(
  redirectTo: string,
  userOrigin: string,
  adminOrigin: string,
  extraBffOrigins?: string,
): boolean {
  let redirectUrl: URL;
  try {
    redirectUrl = new URL(redirectTo);
  } catch {
    return false;
  }

  // HTTPS のみ許可
  if (redirectUrl.protocol !== "https:") return false;

  // USER_ORIGIN / ADMIN_ORIGIN と origin 単位で完全一致比較
  const bffOrigins = [userOrigin, adminOrigin];
  if (
    bffOrigins.some((o) => {
      try {
        return redirectUrl.origin === new URL(o).origin;
      } catch {
        return false;
      }
    })
  ) {
    return true;
  }

  // EXTRA_BFF_ORIGINS による追加オリジン（外部ドメイン向け）
  return matchesExtraBffOrigins(redirectUrl, extraBffOrigins);
}

function setSecureCookie(
  c: Context<{ Bindings: IdpEnv; Variables: Variables }>,
  name: string,
  value: string,
  maxAge: number,
): void {
  setCookie(c, name, value, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge,
  });
}

/**
 * state Cookie を安全に検証・パースする
 * 検証失敗または不正な JSON の場合は null を返す
 */
async function parseStateFromCookie(
  stateCookieRaw: string,
  secret: string,
): Promise<OAuthStateCookieData | null> {
  const verifiedPayload = await verifyCookie(stateCookieRaw, secret);
  if (!verifiedPayload) return null;

  try {
    const parsed: unknown = JSON.parse(verifiedPayload);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "idState" in parsed &&
      "redirectTo" in parsed &&
      "bffState" in parsed
    ) {
      return parsed as OAuthStateCookieData;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * SNSプロバイダー連携のラッパー。
 * PROVIDER_ALREADY_LINKEDエラーを捕捉し、判別可能な戻り値として返す。
 */
async function handleProviderLink(
  db: D1Database,
  linkUserId: string,
  provider: OAuthProvider,
  providerSub: string,
): Promise<{ ok: true; user: User } | { ok: false }> {
  try {
    const user = await linkProvider(db, linkUserId, provider, providerSub);
    return { ok: true, user };
  } catch (err) {
    if (err instanceof Error && err.message === "PROVIDER_ALREADY_LINKED") {
      return { ok: false };
    }
    throw err;
  }
}

function oauthError(
  c: Context<{ Bindings: IdpEnv; Variables: Variables }>,
  message: string,
  code: string = "OAUTH_ERROR",
): { ok: false; response: Response } {
  return { ok: false, response: c.json({ error: { code, message } }, 400) };
}

// ─── プロバイダー共通ヘルパー ─────────────────────────────────────────────────

/**
 * OAuthプロバイダー共通のコード交換・ユーザー情報取得処理。
 * 各 resolve*Provider 関数の try/catch ボイラープレートを集約する。
 */
async function exchangeAndFetchUserInfo<TTokenResponse extends { access_token: string }, TUserInfo>(
  c: Context<{ Bindings: IdpEnv; Variables: Variables }>,
  providerKey: string,
  displayName: string,
  exchangeFn: () => Promise<TTokenResponse>,
  fetchFn: (accessToken: string) => Promise<TUserInfo>,
): Promise<
  | { ok: true; tokenResponse: TTokenResponse; userInfo: TUserInfo }
  | { ok: false; response: Response }
> {
  let tokens: TTokenResponse;
  try {
    tokens = await exchangeFn();
  } catch (err) {
    authLogger.error(`[oauth-${providerKey}] Failed to exchange code`, err);
    return oauthError(c, `Failed to exchange ${displayName} code`);
  }

  let userInfo: TUserInfo;
  try {
    userInfo = await fetchFn(tokens.access_token);
  } catch (err) {
    authLogger.error(`[oauth-${providerKey}] Failed to fetch user info`, err);
    return oauthError(c, `Failed to fetch ${displayName} user info`);
  }

  return { ok: true, tokenResponse: tokens, userInfo };
}

// ─── プロバイダー固有の認証解決関数 ──────────────────────────────────────────

function makePlaceholderEmail(
  provider: string,
  sub: string,
  rawEmail?: string | null,
): { email: string; isPlaceholderEmail: boolean } {
  return {
    email: rawEmail || `${provider}_${sub}@${provider}.placeholder`,
    isPlaceholderEmail: !rawEmail,
  };
}

/** OAuthプロバイダーのコード交換・ユーザー情報取得・upsert関数を一元化 */
async function resolveProvider(
  c: Context<{ Bindings: IdpEnv; Variables: Variables }>,
  provider: OAuthProvider,
  code: string,
  pkceVerifier: string,
  callbackUri: string,
): Promise<ProviderResolution> {
  switch (provider) {
    case "google": {
      const result = await exchangeAndFetchUserInfo(
        c,
        "google",
        "Google",
        () =>
          exchangeGoogleCode({
            code,
            clientId: c.env.GOOGLE_CLIENT_ID,
            clientSecret: c.env.GOOGLE_CLIENT_SECRET,
            redirectUri: callbackUri,
            codeVerifier: pkceVerifier,
          }),
        fetchGoogleUserInfo,
      );
      if (!result.ok) return result;
      const { userInfo } = result;
      if (!userInfo.email_verified) {
        return oauthError(c, "Email not verified", "UNVERIFIED_EMAIL");
      }
      return {
        ok: true,
        sub: userInfo.sub,
        upsert: (db, id) =>
          upsertUser(db, {
            id,
            googleSub: userInfo.sub,
            email: userInfo.email,
            emailVerified: userInfo.email_verified,
            name: userInfo.name,
            picture: userInfo.picture ?? null,
          }),
      };
    }

    case "line": {
      const result = await exchangeAndFetchUserInfo(
        c,
        "line",
        "LINE",
        () =>
          exchangeLineCode({
            code,
            clientId: c.env.LINE_CLIENT_ID!,
            clientSecret: c.env.LINE_CLIENT_SECRET!,
            redirectUri: callbackUri,
            codeVerifier: pkceVerifier,
          }),
        fetchLineUserInfo,
      );
      if (!result.ok) return result;
      const { userInfo } = result;
      const { email, isPlaceholderEmail } = makePlaceholderEmail(
        "line",
        userInfo.sub,
        userInfo.email,
      );
      return {
        ok: true,
        sub: userInfo.sub,
        upsert: (db, id) =>
          upsertLineUser(db, {
            id,
            lineSub: userInfo.sub,
            email,
            isPlaceholderEmail,
            name: userInfo.name,
            picture: userInfo.picture ?? null,
          }),
      };
    }

    case "twitch": {
      const result = await exchangeAndFetchUserInfo(
        c,
        "twitch",
        "Twitch",
        () =>
          exchangeTwitchCode({
            code,
            clientId: c.env.TWITCH_CLIENT_ID!,
            clientSecret: c.env.TWITCH_CLIENT_SECRET!,
            redirectUri: callbackUri,
            codeVerifier: pkceVerifier,
          }),
        fetchTwitchUserInfo,
      );
      if (!result.ok) return result;
      const { userInfo } = result;
      const { email, isPlaceholderEmail } = makePlaceholderEmail(
        "twitch",
        userInfo.sub,
        userInfo.email,
      );
      if (!isPlaceholderEmail && !(userInfo.email_verified ?? false)) {
        return oauthError(c, "Email not verified", "UNVERIFIED_EMAIL");
      }
      return {
        ok: true,
        sub: userInfo.sub,
        upsert: (db, id) =>
          upsertTwitchUser(db, {
            id,
            twitchSub: userInfo.sub,
            email,
            isPlaceholderEmail,
            emailVerified: userInfo.email_verified ?? false,
            name: userInfo.preferred_username,
            picture: userInfo.picture ?? null,
          }),
      };
    }

    case "github": {
      const result = await exchangeAndFetchUserInfo(
        c,
        "github",
        "GitHub",
        () =>
          exchangeGithubCode({
            code,
            clientId: c.env.GITHUB_CLIENT_ID!,
            clientSecret: c.env.GITHUB_CLIENT_SECRET!,
            redirectUri: callbackUri,
            codeVerifier: pkceVerifier,
          }),
        fetchGithubUserInfo,
      );
      if (!result.ok) return result;
      const { tokenResponse, userInfo: githubUser } = result;
      const githubSub = String(githubUser.id);
      // GitHub User APIのemailフィールドは検証済みとは限らないため、
      // 常にEmails APIから検証済みプライマリメールを取得する
      let email: string | null;
      try {
        email = await fetchGithubPrimaryEmail(tokenResponse.access_token);
      } catch (err) {
        authLogger.error("[oauth-github] Failed to fetch primary email", err);
        return oauthError(c, "Failed to fetch GitHub email");
      }
      const { email: finalEmail, isPlaceholderEmail } = makePlaceholderEmail(
        "github",
        githubSub,
        email,
      );
      return {
        ok: true,
        sub: githubSub,
        upsert: (db, id) =>
          upsertGithubUser(db, {
            id,
            githubSub,
            email: finalEmail,
            isPlaceholderEmail,
            name: githubUser.name ?? githubUser.login,
            picture: githubUser.avatar_url,
          }),
      };
    }

    case "x": {
      const result = await exchangeAndFetchUserInfo(
        c,
        "x",
        "X",
        () =>
          exchangeXCode({
            code,
            clientId: c.env.X_CLIENT_ID!,
            clientSecret: c.env.X_CLIENT_SECRET!,
            redirectUri: callbackUri,
            codeVerifier: pkceVerifier,
          }),
        fetchXUserInfo,
      );
      if (!result.ok) return result;
      const { userInfo: xUser } = result;
      const { email: xEmail } = makePlaceholderEmail("x", xUser.id);
      return {
        ok: true,
        sub: xUser.id,
        upsert: (db, id) =>
          upsertXUser(db, {
            id,
            xSub: xUser.id,
            email: xEmail,
            isPlaceholderEmail: true,
            name: xUser.name ?? xUser.username,
            picture: xUser.profile_image_url ?? null,
          }),
      };
    }
  }
}

// ─── ルートハンドラー ──────────────────────────────────────────────────────────

// GET /auth/authorize — 標準 OAuth 2.0 Authorization エンドポイント (RFC 6749 / RFC 7636 / RFC 8252)
// MCPクライアント等のネイティブアプリが直接HTTPリクエストで利用する
app.get("/authorize", authRateLimitMiddleware, async (c) => {
  const responseType = c.req.query("response_type");
  const clientId = c.req.query("client_id");
  const redirectUri = c.req.query("redirect_uri");
  const scope = c.req.query("scope");
  const state = c.req.query("state");
  const codeChallenge = c.req.query("code_challenge");
  const codeChallengeMethod = c.req.query("code_challenge_method");
  // OIDC: nonce は任意パラメータ（ID Token にリプレイ攻撃対策として埋め込む）
  const nonce = c.req.query("nonce");

  // 必須パラメータ検証
  if (responseType !== "code") {
    return c.json(
      {
        error: "unsupported_response_type",
        error_description: "Only response_type=code is supported",
      },
      400,
    );
  }
  if (!clientId) {
    return c.json({ error: "invalid_request", error_description: "client_id is required" }, 400);
  }
  if (!redirectUri) {
    return c.json({ error: "invalid_request", error_description: "redirect_uri is required" }, 400);
  }
  if (!state) {
    return c.json({ error: "invalid_request", error_description: "state is required" }, 400);
  }
  if (!codeChallenge) {
    return c.json(
      { error: "invalid_request", error_description: "code_challenge is required (PKCE S256)" },
      400,
    );
  }
  if (codeChallengeMethod !== "S256") {
    return c.json(
      {
        error: "invalid_request",
        error_description: "Only code_challenge_method=S256 is supported",
      },
      400,
    );
  }
  // RFC 7636 §4.2: S256のcode_challengeはBASE64URL(SHA256(code_verifier)) = 43文字
  const codeChallengeError = validateCodeChallenge(codeChallenge);
  if (codeChallengeError) {
    return c.json({ error: "invalid_request", error_description: codeChallengeError }, 400);
  }

  // パラメータ長制限
  if (redirectUri.length > 2048) {
    return c.json({ error: "invalid_request", error_description: "redirect_uri too long" }, 400);
  }
  if (state.length > 1024) {
    return c.json({ error: "invalid_request", error_description: "state too long" }, 400);
  }
  if (scope && scope.length > 2048) {
    return c.json({ error: "invalid_request", error_description: "scope too long" }, 400);
  }
  // nonce はOIDCオプション。長さ + 制御文字を検証（OIDC Core 1.0 §3.1.2.1）
  const nonceError = validateNonce(nonce);
  if (nonceError) {
    return c.json({ error: "invalid_request", error_description: nonceError }, 400);
  }

  // サービス検証
  let service: Awaited<ReturnType<typeof findServiceByClientId>>;
  try {
    service = await findServiceByClientId(c.env.DB, clientId);
  } catch {
    return c.json({ error: "server_error", error_description: "Internal server error" }, 500);
  }
  if (!service) {
    return c.json({ error: "invalid_request", error_description: "Unknown client_id" }, 400);
  }

  // redirect_uri 検証（localhost/127.0.0.1 の場合はポートを無視: RFC 8252 §7.3）
  const normalizedRequested = normalizeRedirectUri(redirectUri);
  if (!normalizedRequested) {
    return c.json({ error: "invalid_request", error_description: "Invalid redirect_uri" }, 400);
  }

  // 登録済みredirect_uriを取得して、matchRedirectUriで比較
  let registeredUris: Awaited<ReturnType<typeof listRedirectUris>>;
  try {
    registeredUris = await listRedirectUris(c.env.DB, service.id);
  } catch {
    return c.json({ error: "server_error", error_description: "Internal server error" }, 500);
  }
  const matched = registeredUris.some((ru) => matchRedirectUri(ru.uri, normalizedRequested));
  if (!matched) {
    return c.json(
      {
        error: "invalid_request",
        error_description: "redirect_uri not registered for this client",
      },
      400,
    );
  }

  // ユーザーをプロバイダー選択画面（USER_ORIGIN/login）にリダイレクト
  // BFFのログイン画面がプロバイダー選択とIdPへの/auth/loginリダイレクトを担当する
  const loginUrl = new URL("/login", c.env.USER_ORIGIN);
  loginUrl.searchParams.set("service_id", service.id);
  loginUrl.searchParams.set("client_id", clientId);
  loginUrl.searchParams.set("redirect_uri", redirectUri);
  loginUrl.searchParams.set("state", state);
  loginUrl.searchParams.set("code_challenge", codeChallenge);
  loginUrl.searchParams.set("code_challenge_method", codeChallengeMethod);
  if (scope) {
    loginUrl.searchParams.set("scope", scope);
  }
  // OIDC: nonce を転送（ID Token に埋め込むため USER_ORIGIN/login → IdP /auth/login → auth code → token発行まで引き継ぐ）
  if (nonce) {
    loginUrl.searchParams.set("nonce", nonce);
  }

  return c.redirect(loginUrl.toString());
});

// GET /auth/login — BFFからのリダイレクト受け取り + プロバイダー認可へリダイレクト
// client_id を指定すると登録済みサービスの redirect URI で検証（OAuth 2.0 Authorization Code フロー）
app.get("/login", authRateLimitMiddleware, async (c) => {
  const redirectTo = c.req.query("redirect_to");
  const bffState = c.req.query("state");
  const providerParam = c.req.query("provider") ?? "google";
  const clientId = c.req.query("client_id");
  // link_user_id を直接URLパラメータとして受け付けるのはアカウント乗っ取り攻撃に悪用可能なため、
  // サーバー側で発行したワンタイムトークン（link_token）を使用する
  const linkToken = c.req.query("link_token");

  if (!redirectTo || !bffState) {
    return c.json({ error: { code: "BAD_REQUEST", message: "Missing required parameters" } }, 400);
  }

  // redirect_to パラメータの長さ制限（Cookie内stateData肥大化防止）
  if (redirectTo.length > 2048) {
    return c.json({ error: { code: "BAD_REQUEST", message: "redirect_to too long" } }, 400);
  }

  // state パラメータの長さ制限（Cookie汚染・過大データ保存防止）
  if (bffState.length > 1024) {
    return c.json({ error: { code: "BAD_REQUEST", message: "state parameter too long" } }, 400);
  }

  // providerの検証
  if (!isValidProvider(providerParam)) {
    return c.json({ error: { code: "BAD_REQUEST", message: "Invalid provider" } }, 400);
  }
  const provider = providerParam;

  // プロバイダー資格情報の確認（Google以外はオプション設定）
  if (provider !== "google") {
    const creds = PROVIDER_CREDENTIALS[provider];
    if (!c.env[creds.id] || !c.env[creds.secret]) {
      return c.json(
        {
          error: {
            code: "PROVIDER_NOT_CONFIGURED",
            message: `${creds.name} provider is not configured`,
          },
        },
        400,
      );
    }
  }

  // redirect_to の検証
  // client_id 指定あり → 登録済みサービスの redirect URI テーブルで検証（外部サービス OAuth フロー）
  // client_id 指定なし → 同一ベースドメイン / EXTRA_BFF_ORIGINS で検証（BFF フロー）
  let serviceId: string | undefined;
  if (clientId) {
    const service = await findServiceByClientId(c.env.DB, clientId);
    if (!service) {
      return c.json({ error: { code: "BAD_REQUEST", message: "Invalid client_id" } }, 400);
    }
    const normalizedRedirectTo = normalizeRedirectUri(redirectTo);
    if (!normalizedRedirectTo) {
      return c.json({ error: { code: "BAD_REQUEST", message: "Invalid redirect_to" } }, 400);
    }
    // 登録済みredirect_uriをmatchRedirectUriで比較（/auth/authorizeと同じロジック）
    // localhostの場合はポート番号を無視してマッチ（RFC 8252 §7.3準拠）
    const registeredUris = await listRedirectUris(c.env.DB, service.id);
    const matched = registeredUris.some((ru) => matchRedirectUri(ru.uri, normalizedRedirectTo));
    if (!matched) {
      return c.json({ error: { code: "BAD_REQUEST", message: "Invalid redirect_to" } }, 400);
    }
    serviceId = service.id;
  } else {
    // client_id なしは BFF オリジン（USER_ORIGIN / ADMIN_ORIGIN / EXTRA_BFF_ORIGINS）のみ許可
    const isBff = isBffOrigin(
      redirectTo,
      c.env.USER_ORIGIN,
      c.env.ADMIN_ORIGIN,
      c.env.EXTRA_BFF_ORIGINS,
    );
    if (!isBff) {
      // redirect_to が *.0g0.xyz など同一ベースドメインに属していても、
      // client_id なしでの外部サービスフローは拒否する
      const isKnownDomain = isAllowedRedirectTo(
        redirectTo,
        c.env.IDP_ORIGIN,
        c.env.EXTRA_BFF_ORIGINS,
      );
      if (isKnownDomain) {
        return c.json(
          {
            error: { code: "BAD_REQUEST", message: "client_id is required for external services" },
          },
          400,
        );
      }
      return c.json({ error: { code: "BAD_REQUEST", message: "Invalid redirect_to" } }, 400);
    }
  }

  // OIDCオプションパラメータ
  const nonce = c.req.query("nonce");
  const codeChallenge = c.req.query("code_challenge");

  // nonce の長さ・制御文字制限（RFC 7636 に準じて 128 文字まで、制御文字禁止）
  const nonceError = validateNonce(nonce);
  if (nonceError) {
    return c.json({ error: { code: "BAD_REQUEST", message: nonceError } }, 400);
  }
  const codeChallengeMethod = c.req.query("code_challenge_method");
  const scope = c.req.query("scope");

  // scope の長さ制限
  if (scope !== undefined && scope.length > 2048) {
    return c.json({ error: { code: "BAD_REQUEST", message: "scope too long" } }, 400);
  }

  // code_challenge が指定された場合は S256 のみ許可（OAuth 2.1 / RFC 7636）
  // code_challenge_method が省略された場合も拒否（デフォルトplainとの混同防止）
  if (codeChallenge && codeChallengeMethod !== "S256") {
    return c.json(
      { error: { code: "BAD_REQUEST", message: "Only S256 code_challenge_method is supported" } },
      400,
    );
  }
  if (!codeChallenge && codeChallengeMethod !== undefined) {
    return c.json(
      {
        error: {
          code: "BAD_REQUEST",
          message: "code_challenge is required when code_challenge_method is specified",
        },
      },
      400,
    );
  }
  // RFC 7636 §4.2: S256のcode_challengeはBASE64URL(SHA256(code_verifier)) = 43文字
  const codeChallengeError = validateCodeChallenge(codeChallenge);
  if (codeChallengeError) {
    return c.json({ error: { code: "BAD_REQUEST", message: codeChallengeError } }, 400);
  }

  // link_token の検証（SNSプロバイダー連携フロー）
  // HMAC-SHA256署名付きトークン（signCookie/verifyCookieパターン）で検証する（DBアクセス不要）
  let linkUserId: string | undefined;
  if (linkToken) {
    const payload = await verifyCookie(linkToken, c.env.COOKIE_SECRET);
    if (!payload) {
      return c.json(
        { error: { code: "INVALID_LINK_TOKEN", message: "Invalid or expired link token" } },
        400,
      );
    }
    let parsed: { sub: string; exp: number };
    try {
      parsed = JSON.parse(payload) as { sub: string; exp: number };
    } catch {
      return c.json(
        { error: { code: "INVALID_LINK_TOKEN", message: "Invalid or expired link token" } },
        400,
      );
    }
    if (!parsed.sub || typeof parsed.exp !== "number" || parsed.exp < Date.now()) {
      return c.json(
        { error: { code: "INVALID_LINK_TOKEN", message: "Invalid or expired link token" } },
        400,
      );
    }
    linkUserId = parsed.sub;
  }

  // id側のstate/PKCEを生成
  const idState = generateToken(16);
  const idCodeVerifier = generateCodeVerifier();
  const idCodeChallenge = await generateCodeChallenge(idCodeVerifier);

  // BFF情報をstate cookieに結びつけて保存（provider / serviceId も含める）
  // HMAC-SHA256署名付きCookieで改ざんを防止する
  const statePayload: OAuthStateCookieData = {
    idState,
    bffState,
    redirectTo,
    provider,
    ...(linkUserId ? { linkUserId } : {}),
    ...(serviceId ? { serviceId } : {}),
    ...(nonce ? { nonce } : {}),
    ...(codeChallenge ? { codeChallenge, codeChallengeMethod: codeChallengeMethod ?? "S256" } : {}),
    ...(scope ? { scope } : {}),
  };
  const stateData = JSON.stringify(statePayload);
  const signedStateData = await signCookie(stateData, c.env.COOKIE_SECRET);
  setSecureCookie(c, STATE_COOKIE, signedStateData, 600); // 10分
  setSecureCookie(c, PKCE_COOKIE, idCodeVerifier, 600);

  const callbackUri = `${c.env.IDP_ORIGIN}${CALLBACK_PATH}`;
  const commonParams = { redirectUri: callbackUri, state: idState, codeChallenge: idCodeChallenge };

  switch (provider) {
    case "line":
      return c.redirect(buildLineAuthUrl({ ...commonParams, clientId: c.env.LINE_CLIENT_ID! }));
    case "twitch":
      return c.redirect(buildTwitchAuthUrl({ ...commonParams, clientId: c.env.TWITCH_CLIENT_ID! }));
    case "github":
      return c.redirect(buildGithubAuthUrl({ ...commonParams, clientId: c.env.GITHUB_CLIENT_ID! }));
    case "x":
      return c.redirect(buildXAuthUrl({ ...commonParams, clientId: c.env.X_CLIENT_ID! }));
    case "google":
      return c.redirect(buildGoogleAuthUrl({ ...commonParams, clientId: c.env.GOOGLE_CLIENT_ID }));
  }
});

// GET /auth/callback — OAuthコールバック（全プロバイダー共通）
app.get("/callback", authRateLimitMiddleware, async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const error = c.req.query("error");

  if (error) {
    // RFC 6749 §4.1.2.1: プロバイダーエラーはBFFコールバックURLへリダイレクト転送
    const stateCookieRaw = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: "/", secure: true });
    deleteCookie(c, PKCE_COOKIE, { path: "/", secure: true });

    if (stateCookieRaw) {
      const stateData = await parseStateFromCookie(stateCookieRaw, c.env.COOKIE_SECRET);
      if (stateData) {
        const safeErrorCode = error in OAUTH_ERROR_MAP ? error : "access_denied";
        const errorUrl = new URL(stateData.redirectTo);
        errorUrl.searchParams.set("error", safeErrorCode);
        errorUrl.searchParams.set("state", stateData.bffState);
        return c.redirect(errorUrl.toString());
      }
    }

    const safeMessage =
      OAUTH_ERROR_MAP[error as keyof typeof OAUTH_ERROR_MAP] ?? "Authentication failed";
    return c.json({ error: { code: "OAUTH_ERROR", message: safeMessage } }, 400);
  }

  if (!code || !state) {
    deleteCookie(c, STATE_COOKIE, { path: "/", secure: true });
    deleteCookie(c, PKCE_COOKIE, { path: "/", secure: true });
    return c.json({ error: { code: "BAD_REQUEST", message: "Missing code or state" } }, 400);
  }

  // Cookie検証
  const stateCookieRaw = getCookie(c, STATE_COOKIE);
  const pkceVerifier = getCookie(c, PKCE_COOKIE);

  if (!stateCookieRaw || !pkceVerifier) {
    return c.json({ error: { code: "BAD_REQUEST", message: "Missing session cookies" } }, 400);
  }

  let stateData: OAuthStateCookieData;

  // HMAC-SHA256署名を検証してからpayloadをパースする（Cookie改ざん検知）
  const verifiedPayload = await verifyCookie(stateCookieRaw, c.env.COOKIE_SECRET);
  if (!verifiedPayload) {
    authLogger.error("[oauth-callback] State cookie signature verification failed");
    deleteCookie(c, STATE_COOKIE, { path: "/", secure: true });
    deleteCookie(c, PKCE_COOKIE, { path: "/", secure: true });
    return c.json({ error: { code: "BAD_REQUEST", message: "Invalid state cookie" } }, 400);
  }

  try {
    stateData = JSON.parse(verifiedPayload);
  } catch (err) {
    authLogger.error("[oauth-callback] Failed to parse state cookie", err);
    deleteCookie(c, STATE_COOKIE, { path: "/", secure: true });
    deleteCookie(c, PKCE_COOKIE, { path: "/", secure: true });
    return c.json({ error: { code: "BAD_REQUEST", message: "Invalid state cookie" } }, 400);
  }

  // state検証（タイミング攻撃対策のため定数時間比較を使用）
  if (!timingSafeEqual(state, stateData.idState)) {
    deleteCookie(c, STATE_COOKIE, { path: "/", secure: true });
    deleteCookie(c, PKCE_COOKIE, { path: "/", secure: true });
    return c.json({ error: { code: "BAD_REQUEST", message: "State mismatch" } }, 400);
  }

  // Cookie削除（__Host- prefix には secure: true が必須）
  deleteCookie(c, STATE_COOKIE, { path: "/", secure: true });
  deleteCookie(c, PKCE_COOKIE, { path: "/", secure: true });

  const callbackUri = `${c.env.IDP_ORIGIN}${CALLBACK_PATH}`;

  // providerの検証（Cookie改ざん対策）
  if (!stateData.provider) {
    return c.json({ error: { code: "BAD_REQUEST", message: "Missing provider in state" } }, 400);
  }
  const provider: OAuthProvider = stateData.provider;
  if (!isValidProvider(provider)) {
    return c.json({ error: { code: "BAD_REQUEST", message: "Invalid provider in state" } }, 400);
  }

  // Google以外はオプション設定のため資格情報の存在を確認
  if (provider !== "google") {
    const creds = PROVIDER_CREDENTIALS[provider];
    if (!c.env[creds.id] || !c.env[creds.secret]) {
      return c.json(
        {
          error: {
            code: "PROVIDER_NOT_CONFIGURED",
            message: `${creds.name} provider is not configured`,
          },
        },
        400,
      );
    }
  }

  // プロバイダー固有の認証処理（コード交換・ユーザー情報取得）
  const resolved = await resolveProvider(c, provider, code, pkceVerifier, callbackUri);
  if (!resolved.ok) return resolved.response;

  // アカウント連携またはユーザー作成/更新
  const userId = crypto.randomUUID();
  let user: User;
  if (stateData.linkUserId) {
    // BAN済みユーザーへのプロバイダー連携を防止（DBに書き込む前にチェック）
    const linkTargetUser = await findUserById(c.env.DB, stateData.linkUserId);
    if (!linkTargetUser || linkTargetUser.banned_at !== null) {
      return c.json(
        { error: { code: "ACCOUNT_BANNED", message: "Your account has been suspended" } },
        403,
      );
    }
    const result = await handleProviderLink(c.env.DB, stateData.linkUserId, provider, resolved.sub);
    if (!result.ok) {
      return c.json(
        {
          error: {
            code: "PROVIDER_ALREADY_LINKED",
            message: `This ${PROVIDER_DISPLAY_NAMES[provider]} account is already linked to another user`,
          },
        },
        409,
      );
    }
    user = result.user;
  } else {
    user = await resolved.upsert(c.env.DB, userId);
  }

  // BANされたユーザーのログインを拒否
  if (user.banned_at !== null) {
    return c.json(
      { error: { code: "ACCOUNT_BANNED", message: "Your account has been suspended" } },
      403,
    );
  }

  // 管理者ブートストラップ（管理者が0人の場合のみ・原子的操作）
  if (
    c.env.BOOTSTRAP_ADMIN_EMAIL &&
    user.email.toLowerCase() === c.env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase() &&
    user.role !== "admin"
  ) {
    try {
      const elevated = await tryBootstrapAdmin(c.env.DB, user.id);
      if (elevated) user.role = "admin";
    } catch (err) {
      authLogger.error("[bootstrap] Failed to elevate bootstrap admin", err);
      return c.json(
        {
          error: {
            code: "INTERNAL_ERROR",
            message: "Failed to elevate bootstrap admin. Please try again.",
          },
        },
        500,
      );
    }
  }

  // ログインイベント記録（エラーがあってもログインフローは継続）
  try {
    const ipAddress = getClientIp(c.req.raw);
    // user-agent は任意長の文字列のため 512 文字に切り詰め（ストレージ DoS 防止）
    const userAgent = c.req.header("user-agent")?.slice(0, 512) ?? null;
    const country = c.req.header("cf-ipcountry") ?? null;
    await insertLoginEvent(c.env.DB, {
      userId: user.id,
      provider,
      ipAddress,
      userAgent,
      country,
    });
  } catch (err) {
    authLogger.error("[login-event] Failed to record login event", err);
  }

  // ワンタイム認可コード発行
  const authCode = generateToken(32);
  const codeHash = await sha256(authCode);
  const expiresAt = new Date(Date.now() + 60 * 1000).toISOString();

  try {
    await createAuthCode(c.env.DB, {
      id: crypto.randomUUID(),
      userId: user.id,
      serviceId: stateData.serviceId ?? null,
      codeHash,
      redirectTo: stateData.redirectTo,
      expiresAt,
      nonce: stateData.nonce ?? null,
      codeChallenge: stateData.codeChallenge ?? null,
      codeChallengeMethod: stateData.codeChallengeMethod ?? null,
      scope: stateData.scope ?? null,
    });
  } catch (err) {
    authLogger.error("[callback] Failed to create authorization code", err);
    return c.json(
      { error: { code: "SERVER_ERROR", message: "Failed to create authorization code" } },
      500,
    );
  }

  // BFFコールバックへリダイレクト
  const callbackUrl = new URL(stateData.redirectTo);
  callbackUrl.searchParams.set("code", authCode);
  callbackUrl.searchParams.set("state", stateData.bffState);

  return c.redirect(callbackUrl.toString());
});

// POST /auth/exchange — ワンタイムコード交換
// BFF（service_id なし）および外部サービス（service_id あり）の両方をサポート
app.post("/exchange", tokenApiRateLimitMiddleware, serviceBindingMiddleware, async (c) => {
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
    let service: Awaited<ReturnType<typeof authenticateService>>;
    try {
      service = await authenticateService(c.env.DB, c.req.header("Authorization"));
    } catch {
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
    idTokenSub = await sha256(`${service.client_id}:${user.id}`);
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
      },
      c.env.JWT_PRIVATE_KEY,
      c.env.JWT_PUBLIC_KEY,
    );
  }

  return c.json({
    data: {
      access_token: accessToken,
      ...(idToken ? { id_token: idToken } : {}),
      refresh_token: refreshTokenRaw,
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
});

// POST /auth/refresh — トークンリフレッシュ（BFFサーバー間専用）
app.post("/refresh", tokenApiRateLimitMiddleware, serviceBindingMiddleware, async (c) => {
  const result = await parseJsonBody(c, RefreshSchema);
  if (!result.ok) return result.response;

  const tokenHash = await sha256(result.data.refresh_token);

  const validationResult = await validateAndRevokeRefreshToken(c.env.DB, tokenHash);
  if (!validationResult.ok) {
    if (validationResult.reason === "TOKEN_ROTATED") {
      return c.json(
        {
          error: { code: "TOKEN_ROTATED", message: "Token already rotated, retry with new token" },
        },
        401,
      );
    }
    if (validationResult.reason === "TOKEN_REUSE") {
      return c.json({ error: { code: "TOKEN_REUSE", message: "Token reuse detected" } }, 401);
    }
    return c.json({ error: { code: "INVALID_TOKEN", message: "Token not found" } }, 401);
  }
  const storedToken = validationResult.storedToken;

  // 有効期限チェック
  // 期限切れトークンは rotation 済みの状態のまま拒否する（unrevoke は不要かつ危険）。
  // unrevoke すると次回の再提示で reuse detection が誤発動せず、
  // 失効済みトークンの再利用チェックが機能しなくなるため。
  if (new Date(storedToken.expires_at) < new Date()) {
    return c.json({ error: { code: "TOKEN_EXPIRED", message: "Refresh token expired" } }, 401);
  }

  // ユーザー情報取得
  const user = await findUserById(c.env.DB, storedToken.user_id);
  if (!user) {
    return c.json({ error: { code: "INVALID_GRANT", message: "User not found" } }, 401);
  }

  // BANされたユーザーのトークン更新を拒否
  if (user.banned_at !== null) {
    return c.json(
      { error: { code: "ACCOUNT_BANNED", message: "Your account has been suspended" } },
      403,
    );
  }

  // サービストークンの場合: 元のサービスのスコープを引き継ぐ
  let refreshScope: string | undefined = undefined;
  let refreshService: Awaited<ReturnType<typeof findServiceById>> | undefined = undefined;
  if (storedToken.service_id !== null) {
    refreshService = await findServiceById(c.env.DB, storedToken.service_id);
    if (!refreshService) {
      // サービス削除済み → トークンリフレッシュを拒否
      return c.json({ error: { code: "INVALID_TOKEN", message: "Service no longer exists" } }, 401);
    }
    // 保存済みスコープがあればそれを引き継ぐ（スコープ昇格防止）
    // 保存済みスコープがない（マイグレーション前のトークン）場合はallowed_scopesにフォールバック
    refreshScope = storedToken.scope ?? resolveEffectiveScope(null, refreshService.allowed_scopes);
  }

  const issueResult = await issueTokenPairWithRecovery(
    c.env.DB,
    c.env,
    user,
    {
      serviceId: storedToken.service_id,
      clientId: refreshService?.client_id,
      familyId: storedToken.family_id,
      scope: refreshScope,
    },
    storedToken.id,
    tokenHash,
    authLogger,
    "handleRefresh",
  );
  if (!issueResult.ok) {
    if (issueResult.reason === "TOKEN_REUSE") {
      return c.json({ error: { code: "TOKEN_REUSE", message: "Token reuse detected" } }, 401);
    }
    return c.json({ error: { code: "INTERNAL_ERROR", message: "Token operation failed" } }, 500);
  }
  const accessToken = issueResult.accessToken;
  const newRefreshTokenRaw = issueResult.refreshToken;

  return c.json({
    data: {
      access_token: accessToken,
      refresh_token: newRefreshTokenRaw,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    },
  });
});

// POST /auth/link-intent — SNSプロバイダー連携用ワンタイムトークン発行（認証済みユーザー専用）
// link_user_id をURLパラメータとして直接受け付けると第三者が任意ユーザーのIDを指定し
// アカウント乗っ取りが可能なため、アクセストークンで認証したうえでワンタイムトークンを発行する
app.post(
  "/link-intent",
  tokenApiRateLimitMiddleware,
  authMiddleware,
  rejectServiceTokenMiddleware,
  rejectBannedUserMiddleware,
  async (c) => {
    const tokenUser = c.get("user");

    // HMAC-SHA256署名付きトークンを生成（DBアクセス不要、自己完結型）
    const tokenPayload = JSON.stringify({
      sub: tokenUser.sub,
      exp: Date.now() + 5 * 60 * 1000, // 5分
    });
    const linkToken = await signCookie(tokenPayload, c.env.COOKIE_SECRET);

    return c.json({ data: { link_token: linkToken } });
  },
);

// POST /auth/logout — ログアウト（BFFサーバー間専用）
app.post("/logout", tokenApiRateLimitMiddleware, serviceBindingMiddleware, async (c) => {
  const result = await parseJsonBody(c, LogoutSchema);
  if (!result.ok) return result.response;

  // アクセストークンの失効処理（Authorizationヘッダーから取得）
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const accessToken = authHeader.slice(7);
    try {
      const payload = await verifyAccessToken(
        accessToken,
        c.env.JWT_PUBLIC_KEY,
        c.env.IDP_ORIGIN,
        c.env.IDP_ORIGIN,
      );
      if (payload.jti && payload.exp && payload.exp > Math.floor(Date.now() / 1000)) {
        await addRevokedAccessToken(c.env.DB, payload.jti, payload.exp);
      }
    } catch {
      // JWT検証失敗は無視してログアウトを続行
    }
  }

  const { refresh_token: refreshToken } = result.data;
  if (refreshToken) {
    const tokenHash = await sha256(refreshToken);
    let storedToken: Awaited<ReturnType<typeof findRefreshTokenByHash>>;
    try {
      storedToken = await findRefreshTokenByHash(c.env.DB, tokenHash);
    } catch (err) {
      authLogger.error("[logout] Failed to find refresh token", err);
      return c.json(
        { error: { code: "INTERNAL_ERROR", message: "Failed to process logout" } },
        500,
      );
    }
    if (storedToken && storedToken.revoked_at === null) {
      try {
        await revokeRefreshToken(c.env.DB, storedToken.id, "user_logout");
      } catch (err) {
        authLogger.error("[logout] Failed to revoke refresh token", err);
        return c.json(
          { error: { code: "INTERNAL_ERROR", message: "Failed to revoke token" } },
          500,
        );
      }
    }
  }

  return c.json({ data: { success: true } });
});

export default app;

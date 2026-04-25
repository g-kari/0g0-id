import type { Context } from "hono";
import type { IdpEnv, OAuthStateCookieData, TokenPayload } from "@0g0-id/shared";
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateToken,
  signCookie,
  verifyCookie,
  buildGoogleAuthUrl,
  buildLineAuthUrl,
  buildTwitchAuthUrl,
  buildGithubAuthUrl,
  buildXAuthUrl,
} from "@0g0-id/shared";
import { isValidProvider } from "@0g0-id/shared";
import { validateNonce, validateCodeChallengeParams } from "../../utils/scopes";
import {
  CALLBACK_PATH,
  STATE_COOKIE,
  PKCE_COOKIE,
  isAllowedRedirectTo,
  isBffOrigin,
  setSecureCookie,
  validateProviderCredentials,
  validateServiceRedirectUri,
} from "../../utils/auth-helpers";

/**
 * GET /auth/login — BFFからのリダイレクト受け取り + プロバイダー認可へリダイレクト
 * client_id を指定すると登録済みサービスの redirect URI で検証（OAuth 2.0 Authorization Code フロー）
 */
type Variables = { user: TokenPayload };

export async function handleLogin(c: Context<{ Bindings: IdpEnv; Variables: Variables }>) {
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
  const credResult = validateProviderCredentials(provider, c.env);
  if (!credResult.ok) {
    return c.json({ error: { code: credResult.code, message: credResult.message } }, 400);
  }

  // redirect_to の検証
  // client_id 指定あり → 登録済みサービスの redirect URI テーブルで検証（外部サービス OAuth フロー）
  // client_id 指定なし → 同一ベースドメイン / EXTRA_BFF_ORIGINS で検証（BFF フロー）
  let serviceId: string | undefined;
  if (clientId) {
    const uriResult = await validateServiceRedirectUri(c.env.DB, clientId, redirectTo);
    if (!uriResult.ok) {
      return c.json({ error: { code: "BAD_REQUEST", message: uriResult.error } }, 400);
    }
    serviceId = uriResult.serviceId;
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

  const codeChallengeError = validateCodeChallengeParams(codeChallenge, codeChallengeMethod);
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
    let parsed: { purpose: string; sub: string; exp: number };
    try {
      parsed = JSON.parse(payload) as { purpose: string; sub: string; exp: number };
    } catch {
      return c.json(
        { error: { code: "INVALID_LINK_TOKEN", message: "Invalid or expired link token" } },
        400,
      );
    }
    if (
      parsed.purpose !== "link" ||
      !parsed.sub ||
      typeof parsed.exp !== "number" ||
      parsed.exp < Date.now()
    ) {
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
}

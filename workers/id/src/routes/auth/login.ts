import type { Context } from "hono";
import { html } from "hono/html";
import type { IdpEnv, OAuthStateCookieData, TokenPayload } from "@0g0-id/shared";
import { restErrorBody } from "@0g0-id/shared";
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
  buildDiscordAuthUrl,
  buildSteamAuthUrl,
  isSocialLoginProvider,
  socialLoginSchemaReady,
  issueSocialLoginTransaction,
  consumeSocialLoginLinkToken,
} from "@0g0-id/shared";
import { isValidProvider } from "@0g0-id/shared";
import { validateNonce, validateCodeChallengeParams } from "../../utils/scopes";
import {
  CALLBACK_PATH,
  STEAM_CALLBACK_PATH,
  STATE_COOKIE,
  PKCE_COOKIE,
  isAllowedRedirectTo,
  isBffOrigin,
  setSecureCookie,
  validateProviderCredentials,
  validateServiceRedirectUri,
  validateResourceParam,
} from "../../utils/auth-helpers";
import { validateRequiredParams, validateParamLengths } from "../../utils/validation";

/**
 * GET /auth/login — BFFからのリダイレクト受け取り + プロバイダー認可へリダイレクト
 * client_id を指定すると登録済みサービスの redirect URI で検証（OAuth 2.0 Authorization Code フロー）
 */
type Variables = { user: TokenPayload };

export async function handleLogin(c: Context<{ Bindings: IdpEnv; Variables: Variables }>) {
  // Browser linking is POST-only from the authenticated BFF page. A bearer URL
  // must not attach a victim provider to the account named by an attacker's intent.
  let form: URLSearchParams | undefined;
  if (c.req.method === "POST") {
    if (
      c.req.header("Origin") !== c.env.USER_ORIGIN ||
      new URL(c.req.url).search ||
      c.req.header("Content-Type")?.split(";")[0] !== "application/x-www-form-urlencoded"
    ) {
      return c.json(restErrorBody("BAD_REQUEST", "Invalid link request"), 400);
    }
    const raw = await c.req.text();
    if (raw.length > 16384)
      return c.json(restErrorBody("BAD_REQUEST", "Invalid link request"), 400);
    form = new URLSearchParams(raw);
    const allowed = new Set(["provider", "redirect_to", "state", "link_token"]);
    for (const key of form.keys())
      if (!allowed.has(key) || form.getAll(key).length !== 1) {
        return c.json(restErrorBody("BAD_REQUEST", "Invalid link request"), 400);
      }
    if (
      form.get("redirect_to") !== `${c.env.USER_ORIGIN}/auth/callback` ||
      !form.get("link_token") ||
      !["discord", "steam"].includes(form.get("provider") ?? "")
    ) {
      return c.json(restErrorBody("BAD_REQUEST", "Invalid link request"), 400);
    }
  }
  const query = (key: string): string | undefined =>
    form ? (form.get(key) ?? undefined) : c.req.query(key);
  const redirectTo = query("redirect_to");
  const bffState = query("state");
  const providerParam = query("provider") ?? "google";
  const clientId = query("client_id");
  // link_user_id を直接URLパラメータとして受け付けるのはアカウント乗っ取り攻撃に悪用可能なため、
  // サーバー側で発行したワンタイムトークン（link_token）を使用する
  const linkToken = query("link_token");

  const requiredErr = validateRequiredParams(c, [
    { value: redirectTo, message: "Missing required parameters" },
    { value: bffState, message: "Missing required parameters" },
  ]);
  if (requiredErr) return requiredErr;
  if (!redirectTo || !bffState) return requiredErr!;

  const lengthErr = validateParamLengths(c, [
    { value: redirectTo, max: 2048, message: "redirect_to too long" },
    { value: bffState, max: 1024, message: "state parameter too long" },
  ]);
  if (lengthErr) return lengthErr;

  // providerの検証
  if (!isValidProvider(providerParam)) {
    return c.json(restErrorBody("BAD_REQUEST", "Invalid provider"), 400);
  }
  const provider = providerParam;
  if (isSocialLoginProvider(provider) && linkToken && c.req.method !== "POST") {
    return c.json(
      restErrorBody("BAD_REQUEST", "Linking must start from your authenticated account page"),
      400,
    );
  }

  // プロバイダー資格情報の確認（Google以外はオプション設定）
  const credResult = validateProviderCredentials(provider, c.env);
  if (!credResult.ok) {
    return c.json(restErrorBody(credResult.code, credResult.message), 400);
  }

  if (isSocialLoginProvider(provider) && !(await socialLoginSchemaReady(c.env.DB))) {
    return c.json(restErrorBody("PROVIDER_NOT_CONFIGURED", "Provider is not configured"), 400);
  }

  // redirect_to の検証
  // client_id 指定あり → 登録済みサービスの redirect URI テーブルで検証（外部サービス OAuth フロー）
  // client_id 指定なし → 同一ベースドメイン / EXTRA_BFF_ORIGINS で検証（BFF フロー）
  let serviceId: string | undefined;
  if (clientId) {
    const uriResult = await validateServiceRedirectUri(c.env.DB, clientId, redirectTo);
    if (!uriResult.ok) {
      return c.json(restErrorBody("BAD_REQUEST", uriResult.error), 400);
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
          restErrorBody("BAD_REQUEST", "client_id is required for external services"),
          400,
        );
      }
      return c.json(restErrorBody("BAD_REQUEST", "Invalid redirect_to"), 400);
    }
  }

  // OIDCオプションパラメータ
  const nonce = query("nonce");
  const codeChallenge = query("code_challenge");

  // nonce の長さ・制御文字制限（RFC 7636 に準じて 128 文字まで、制御文字禁止）
  const nonceError = validateNonce(nonce);
  if (nonceError) {
    return c.json(restErrorBody("BAD_REQUEST", nonceError), 400);
  }
  const codeChallengeMethod = query("code_challenge_method");
  const scope = query("scope");
  const resource = query("resource");

  const scopeLenErr = validateParamLengths(c, [
    { value: scope, max: 2048, message: "scope too long" },
    { value: resource, max: 2048, message: "resource too long" },
  ]);
  if (scopeLenErr) return scopeLenErr;

  // RFC 8707: resource は外部サービスフロー（client_id あり）でのみ有効。
  // /auth/authorize で検証済みだが、/auth/login を直接叩く経路に備えて再検証する
  let resourceUri: string | undefined;
  if (resource) {
    if (!clientId) {
      return c.json(restErrorBody("BAD_REQUEST", "resource requires client_id"), 400);
    }
    const resourceResult = await validateResourceParam(c.env.DB, resource);
    if (!resourceResult.ok) {
      return c.json(restErrorBody("BAD_REQUEST", resourceResult.error), 400);
    }
    resourceUri = resourceResult.uri;
  }

  const codeChallengeError = validateCodeChallengeParams(codeChallenge, codeChallengeMethod);
  if (codeChallengeError) {
    return c.json(restErrorBody("BAD_REQUEST", codeChallengeError), 400);
  }

  // link_token の検証（SNSプロバイダー連携フロー）
  // HMAC-SHA256署名付きトークン（signCookie/verifyCookieパターン）で検証する（DBアクセス不要）
  let linkUserId: string | undefined;
  if (linkToken) {
    const payload = await verifyCookie(linkToken, c.env.COOKIE_SECRET);
    if (!payload) {
      return c.json(restErrorBody("INVALID_LINK_TOKEN", "Invalid or expired link token"), 400);
    }
    let parsed: { purpose: string; sub: string; exp: number; jti?: string; provider?: string };
    try {
      parsed = JSON.parse(payload) as {
        purpose: string;
        sub: string;
        exp: number;
        jti?: string;
        provider?: string;
      };
    } catch {
      return c.json(restErrorBody("INVALID_LINK_TOKEN", "Invalid or expired link token"), 400);
    }
    if (
      (parsed.provider !== undefined && parsed.provider !== provider) ||
      (isSocialLoginProvider(provider) && parsed.provider !== provider) ||
      parsed.purpose !== "link" ||
      !parsed.sub ||
      typeof parsed.exp !== "number" ||
      parsed.exp < Date.now()
    ) {
      return c.json(restErrorBody("INVALID_LINK_TOKEN", "Invalid or expired link token"), 400);
    }
    // jti 消費チェック（ワンタイム性保証）
    if (isSocialLoginProvider(provider)) {
      if (
        typeof parsed.sub !== "string" ||
        !parsed.jti ||
        !(await consumeSocialLoginLinkToken(c.env.DB, parsed.jti, parsed.exp))
      ) {
        return c.json(restErrorBody("INVALID_LINK_TOKEN", "Invalid or expired link token"), 400);
      }
    } else if (parsed.jti && c.env.LINK_TOKEN_KV) {
      const consumed = await c.env.LINK_TOKEN_KV.get(`jti:${parsed.jti}`);
      if (consumed) {
        return c.json(restErrorBody("INVALID_LINK_TOKEN", "Link token already consumed"), 400);
      }
      await c.env.LINK_TOKEN_KV.put(`jti:${parsed.jti}`, "1", { expirationTtl: 120 });
    }
    linkUserId = parsed.sub;
  }

  // id側のstate/PKCEを生成
  const idState = generateToken(isSocialLoginProvider(provider) ? 32 : 16);
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
    ...(resourceUri ? { resource: resourceUri } : {}),
  };
  const stateData = JSON.stringify(statePayload);
  if (isSocialLoginProvider(provider)) {
    await issueSocialLoginTransaction(c.env.DB, {
      state: idState,
      browserBinding: idCodeVerifier,
      statePayload: stateData,
      provider,
      idpOrigin: c.env.IDP_ORIGIN,
    });
  }
  const signedStateData = await signCookie(stateData, c.env.COOKIE_SECRET);
  setSecureCookie(c, STATE_COOKIE, signedStateData, 600); // 10分
  const signedPkce = await signCookie(idCodeVerifier, c.env.COOKIE_SECRET);
  setSecureCookie(c, PKCE_COOKIE, signedPkce, 600);

  const callbackUri = `${c.env.IDP_ORIGIN}${CALLBACK_PATH}`;
  const commonParams = { redirectUri: callbackUri, state: idState, codeChallenge: idCodeChallenge };

  const redirectToProvider = (url: string) => {
    if (c.req.method !== "POST") return c.redirect(url);
    // End the BFF form navigation here: its exact-IdP form-action must not
    // govern a cross-origin redirect chain to the identity provider.
    const nonce = generateToken(24);
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'nonce-${nonce}'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
    );
    return c.html(
      html`<!doctype html>
        <html lang="ja">
          <head>
            <meta charset="UTF-8" />
            <title>ログインを続ける</title>
          </head>
          <body>
            <a id="provider-continue" href="${url}">ログインを続ける</a>
            <script nonce="${nonce}">
              location.replace(document.getElementById("provider-continue").href);
            </script>
          </body>
        </html>`,
    );
  };

  switch (provider) {
    case "discord":
      return redirectToProvider(
        buildDiscordAuthUrl({ ...commonParams, clientId: c.env.DISCORD_CLIENT_ID! }),
      );
    case "steam":
      return redirectToProvider(
        buildSteamAuthUrl(`${c.env.IDP_ORIGIN}${STEAM_CALLBACK_PATH}?state=${idState}`),
      );
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

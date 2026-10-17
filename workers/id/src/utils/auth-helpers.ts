import { type Context } from "hono";
import { setCookie } from "hono/cookie";
import {
  verifyCookie,
  linkProvider,
  COOKIE_NAMES,
  PROVIDER_CREDENTIALS,
  findServiceByClientId,
  normalizeRedirectUri,
  listRedirectUris,
  matchRedirectUri,
} from "@0g0-id/shared";
import type { IdpEnv, TokenPayload, User, OAuthStateCookieData } from "@0g0-id/shared";
import type { OAuthProvider } from "@0g0-id/shared";
import { parse as parseDomain } from "tldts";

type Variables = { user: TokenPayload };

export const CALLBACK_PATH = "/auth/callback";

/**
 * OAuthプロバイダーから返されるエラーコードの安全なマッピング。
 * 未知のエラーコードはフォールバックメッセージに置き換え、
 * プロバイダーの内部情報をそのまま反射することを防ぐ。
 */
export const OAUTH_ERROR_MAP: Record<string, string> = {
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
export const STATE_COOKIE = COOKIE_NAMES.IDP_STATE;
export const PKCE_COOKIE = COOKIE_NAMES.IDP_PKCE;

/**
 * EXTRA_BFF_ORIGINS（カンマ区切り文字列）をパースし、
 * redirectUrl のオリジンがそのいずれかと一致するか確認する。
 */
export function matchesExtraBffOrigins(redirectUrl: URL, extraBffOrigins?: string): boolean {
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

export function setSecureCookie(
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
export async function parseStateFromCookie(
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
export async function handleProviderLink(
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

/**
 * プロバイダー資格情報（client_id/secret）がenv に設定されているか検証する。
 * Google は常に設定済みとみなす。
 */
export function validateProviderCredentials(
  provider: OAuthProvider,
  env: IdpEnv,
): { ok: true } | { ok: false; code: string; message: string } {
  if (provider === "google") return { ok: true };
  const creds = PROVIDER_CREDENTIALS[provider];
  if (!env[creds.id] || !env[creds.secret]) {
    return {
      ok: false,
      code: "PROVIDER_NOT_CONFIGURED",
      message: `${creds.name} provider is not configured`,
    };
  }
  return { ok: true };
}

/**
 * client_id に対応するサービスを検索し、redirectUri が登録済みか検証する。
 * RFC 8252 §7.3: localhost の場合はポート番号を無視してマッチ。
 */
export async function validateServiceRedirectUri(
  db: D1Database,
  clientId: string,
  redirectUri: string,
): Promise<{ ok: true; serviceId: string } | { ok: false; error: string }> {
  const service = await findServiceByClientId(db, clientId);
  if (!service) return { ok: false, error: "Invalid client_id" };

  const normalized = normalizeRedirectUri(redirectUri);
  if (!normalized) return { ok: false, error: "Invalid redirect_uri" };

  const registeredUris = await listRedirectUris(db, service.id);
  const matched = registeredUris.some((ru) => matchRedirectUri(ru.uri, normalized));
  if (!matched) return { ok: false, error: "redirect_uri not registered for this client" };

  return { ok: true, serviceId: service.id };
}

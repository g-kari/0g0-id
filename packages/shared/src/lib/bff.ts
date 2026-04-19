import { type Context } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import type { BffEnv } from "../types";
import { decodeBase64Url } from "./base64url";
import { timingSafeEqual } from "./crypto";
import { logUpstreamDeprecation } from "./internal-secret-deprecation";

/**
 * BFF セッション Cookie の最大有効期間（秒）。
 * issue #139 対応で 30日 → 7日に短縮。Cookie 漏洩時の悪用ウィンドウを制限する。
 */
export const BFF_SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export interface BffSession {
  /**
   * bff_sessions テーブルの行 ID。Cookie 値に含めて送信し、BFF→IdP リクエスト毎に
   * ID Worker 側で失効状態を検証する。Cookie 漏洩時のリモート失効を実現する。
   */
  session_id: string;
  access_token: string;
  refresh_token: string;
  user: { id: string; email: string; name: string; role: "user" | "admin" };
}

/**
 * BffSession の構造を実行時に検証する型ガード。
 * プロトタイプ汚染（JSON.parse による __proto__ インジェクション）への対策として、
 * 既知フィールドのみを明示的に検査する。
 */
function isBffSession(obj: unknown): obj is BffSession {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return false;
  const s = obj as Record<string, unknown>;
  if (typeof s["session_id"] !== "string" || !s["session_id"]) return false;
  if (typeof s["access_token"] !== "string" || !s["access_token"]) return false;
  if (typeof s["refresh_token"] !== "string" || !s["refresh_token"]) return false;
  if (typeof s["user"] !== "object" || s["user"] === null || Array.isArray(s["user"])) return false;
  const u = s["user"] as Record<string, unknown>;
  if (typeof u["id"] !== "string" || !u["id"]) return false;
  if (typeof u["email"] !== "string" || !u["email"]) return false;
  if (typeof u["name"] !== "string" || !u["name"]) return false;
  if (u["role"] !== "user" && u["role"] !== "admin") return false;
  return true;
}

/**
 * SESSION_SECRET から AES-256-GCM 鍵を導出する（HKDF-SHA256）。
 */
async function deriveAesKey(secret: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("0g0-id-bff-session-v1"),
      info: new TextEncoder().encode("bff-session"),
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * セッションCookieをパースしてBffSessionを返す。
 * AES-256-GCM で復号し、JSON.parse の結果を実行時バリデーションする。
 * 復号・パース失敗時は null を返す。
 */
export async function parseSession(
  cookie: string | undefined,
  secret: string,
): Promise<BffSession | null> {
  if (!cookie) return null;
  try {
    // base64url → Uint8Array
    const combined = Uint8Array.from(decodeBase64Url(cookie), (c) => c.charCodeAt(0));

    if (combined.length < 13) return null; // 12バイトIV + 最低1バイト暗号文

    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);

    const key = await deriveAesKey(secret);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    const raw: unknown = JSON.parse(new TextDecoder().decode(plaintext));

    if (!isBffSession(raw)) return null;
    // 既知フィールドのみを抽出してプロトタイプ汚染を防止
    return {
      session_id: raw.session_id,
      access_token: raw.access_token,
      refresh_token: raw.refresh_token,
      user: {
        id: raw.user.id,
        email: raw.user.email,
        name: raw.user.name,
        role: raw.user.role,
      },
    };
  } catch {
    return null;
  }
}

/**
 * BffSession を AES-256-GCM で暗号化して Cookie 値（base64url）として返す。
 * parseSession の逆操作。
 */
export async function encodeSession(session: BffSession, secret: string): Promise<string> {
  const key = await deriveAesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(session));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);

  // IV + 暗号文を結合して base64url エンコード
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(Array.from(combined, (b) => String.fromCharCode(b)).join(""))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/**
 * セッションCookieを30日間有効で設定する。
 */
export async function setSessionCookie(
  c: Context<{ Bindings: BffEnv }>,
  cookieName: string,
  session: BffSession,
): Promise<void> {
  const encoded = await encodeSession(session, c.env.SESSION_SECRET);
  setCookie(c, cookieName, encoded, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    // BFF セッション最大有効期間: 7日（従来30日から短縮）。
    // Cookie が漏洩した場合の悪用ウィンドウを限定しつつ、日常利用での再ログインを避けるバランス。
    // なお bff_sessions テーブルの expires_at もこの値に合わせて設定する。
    maxAge: BFF_SESSION_MAX_AGE_SECONDS,
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * URL 文字列からログ用のパス部分だけを取り出す。
 * 解析に失敗したら元文字列を返す（ログが落ちるのを防ぐ）。
 */
function safePathForLog(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/**
 * BFF→IdP間のService Bindings呼び出しに付与する内部認証ヘッダーを返す。
 *
 * 優先順位（issue #156）:
 * 1. INTERNAL_SERVICE_SECRET_SELF（この BFF 専用シークレット）
 * 2. INTERNAL_SERVICE_SECRET（共有シークレット・後方互換フォールバック）
 * 3. 両方未設定なら空オブジェクト
 *
 * BFF 毎に専用シークレットを持たせることで、漏洩時の影響範囲を当該 BFF に限定できる。
 */
export function internalServiceHeaders(env: BffEnv): Record<string, string> {
  const secret = env.INTERNAL_SERVICE_SECRET_SELF ?? env.INTERNAL_SERVICE_SECRET;
  if (secret) {
    return { "X-Internal-Secret": secret };
  }
  return {};
}

/**
 * BFF→IdP へのリクエストをアクセストークン付きで実行する。
 * 401が返った場合はリフレッシュトークンで再取得してリトライする。
 * リフレッシュに成功した場合はセッションCookieも更新する。
 * Service Bindingのフェッチ失敗は502として返す。
 */
export async function fetchWithAuth(
  c: Context<{ Bindings: BffEnv }>,
  sessionCookieName: string,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const session = await parseSession(getCookie(c, sessionCookieName), c.env.SESSION_SECRET);
  if (!session) {
    return errorResponse(401, "UNAUTHORIZED", "Not authenticated");
  }

  const serviceHeaders = internalServiceHeaders(c.env);

  // BFF セッション ID を ID Worker に渡して bff_sessions の失効チェックを行わせる（issue #139）。
  const bffSessionHeader = { "X-BFF-Session-Id": session.session_id };

  // Deprecation ログ出力時のトレース用 method/path。init.method 未指定時は fetch 仕様に従い GET。
  const primaryMethod = init?.method ?? "GET";
  const primaryPath = safePathForLog(url);

  const makeRequest = (token: string): Promise<Response> =>
    c.env.IDP.fetch(
      new Request(url, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string> | undefined),
          ...serviceHeaders,
          ...bffSessionHeader,
          Authorization: `Bearer ${token}`,
        },
      }),
    );

  let res: Response;
  try {
    res = await makeRequest(session.access_token);
  } catch {
    return errorResponse(502, "UPSTREAM_ERROR", "Failed to reach identity provider");
  }
  logUpstreamDeprecation(res, { method: primaryMethod, path: primaryPath });

  // アクセストークン期限切れ → リフレッシュして再試行
  if (res.status === 401) {
    let refreshRes: Response;
    try {
      refreshRes = await c.env.IDP.fetch(
        new Request(`${c.env.IDP_ORIGIN}/auth/refresh`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...serviceHeaders,
            ...bffSessionHeader,
          },
          body: JSON.stringify({ refresh_token: session.refresh_token }),
        }),
      );
    } catch {
      // リフレッシュ自体が通信失敗 → 502
      return errorResponse(502, "UPSTREAM_ERROR", "Failed to reach identity provider");
    }
    logUpstreamDeprecation(refreshRes, { method: "POST", path: "/auth/refresh" });

    if (refreshRes.ok) {
      const refreshData = await refreshRes.json<{
        data: {
          access_token: string;
          refresh_token: string;
          user?: { id: string; email: string; name: string; role: "user" | "admin" };
        };
      }>();

      // リフレッシュレスポンスの実行時バリデーション
      if (
        typeof refreshData.data?.access_token !== "string" ||
        !refreshData.data.access_token ||
        typeof refreshData.data?.refresh_token !== "string" ||
        !refreshData.data.refresh_token
      ) {
        deleteCookie(c, sessionCookieName, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        });
        return errorResponse(401, "UNAUTHORIZED", "Session expired");
      }

      // セッションCookieを新トークンで更新
      // IdPのリフレッシュレスポンスに含まれる検証済みユーザー情報でセッションを更新する。
      // これにより署名未検証JWTペイロードからのrole抽出が不要になり、
      // admin BFFのセッションベースroleガードが最新のroleを反映できる。
      const updatedUser = refreshData.data.user
        ? {
            id: refreshData.data.user.id,
            email: refreshData.data.user.email,
            name: refreshData.data.user.name,
            role: refreshData.data.user.role,
          }
        : session.user;
      const newSession: BffSession = {
        ...session,
        access_token: refreshData.data.access_token,
        refresh_token: refreshData.data.refresh_token,
        user: updatedUser,
      };
      await setSessionCookie(c, sessionCookieName, newSession);

      try {
        res = await makeRequest(refreshData.data.access_token);
      } catch {
        return errorResponse(502, "UPSTREAM_ERROR", "Failed to reach identity provider");
      }
      logUpstreamDeprecation(res, { method: primaryMethod, path: primaryPath });
    } else if (refreshRes.status >= 500) {
      // リフレッシュエンドポイントが5xx → 502（認証失敗ではなくアップストリーム障害）
      return errorResponse(502, "UPSTREAM_ERROR", "Identity provider error");
    } else if (refreshRes.status === 429) {
      // レートリミット: セッションは有効のままなのでCookieは削除しない。
      // クライアントがリトライできるよう503を返す（ログアウトさせない）。
      return errorResponse(503, "SERVICE_UNAVAILABLE", "Too many requests, please retry later");
    } else {
      // 400/401: リフレッシュ失敗。エラーコードによってセッション削除の判断を分ける。
      let errorCode: string | undefined;
      try {
        const body = await refreshRes.clone().json<{ error?: { code?: string } }>();
        errorCode = body?.error?.code;
      } catch {
        // パース失敗時はターミナルエラーとして扱う
      }

      if (errorCode === "TOKEN_ROTATED") {
        // 並行リクエスト競合: 別の並行リクエストが既にトークンをローテーション済み。
        // セッションCookieは有効（別リクエストが更新済み）なので削除しない。
        // クライアントがリトライできるよう503を返す（ログアウトさせない）。
        return errorResponse(503, "TOKEN_ROTATED", "Token rotation in progress, please retry");
      }

      // TOKEN_REUSE・TOKEN_EXPIRED・INVALID_TOKEN 等の真のセッション無効時のみCookieを削除する
      deleteCookie(c, sessionCookieName, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      });
      return errorResponse(401, "UNAUTHORIZED", "Session expired");
    }
  }

  return res;
}

/**
 * JSONリクエストボディをパースしてBFF→IdPへ転送するユーティリティ。
 * JSONパース失敗時は400を返す。成功時はfetchWithAuthでリクエストを転送しproxyResponseを返す。
 *
 * @example
 * return fetchWithJsonBody(c, SESSION_COOKIE, `${c.env.IDP_ORIGIN}/api/services`, 'POST');
 */
export async function fetchWithJsonBody(
  c: Context<{ Bindings: BffEnv }>,
  sessionCookieName: string,
  url: string,
  method: "POST" | "PATCH" | "PUT" = "POST",
): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return errorResponse(400, "BAD_REQUEST", "Invalid JSON body");
  }

  const res = await fetchWithAuth(c, sessionCookieName, url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: c.env.IDP_ORIGIN,
    },
    body: JSON.stringify(body),
  });
  return proxyResponse(res);
}

/**
 * IdPからのResponseをそのままBFFクライアントへ返すユーティリティ。
 * c.json() の `as 200` 型アサーション回避のため Response を直接構築する。
 * 204 No Content の場合は body なしで返す。
 */
export async function proxyResponse(res: Response): Promise<Response> {
  const safeHeaders = new Headers();
  const contentType = res.headers.get("Content-Type");
  if (contentType) safeHeaders.set("Content-Type", contentType);

  if (res.status === 204) {
    return new Response(null, { status: 204, headers: safeHeaders });
  }
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: safeHeaders,
  });
}

/**
 * ボディなし変更リクエスト（DELETE / PATCH / POST）を BFF→IdP へ転送するユーティリティ。
 * CSRF 対策として Origin ヘッダーを自動付与する。
 *
 * @example
 * // DELETE /api/users/:id/ban
 * return proxyMutate(c, SESSION_COOKIE, `${c.env.IDP_ORIGIN}/api/users/${id}/ban`, 'DELETE');
 */
export async function proxyMutate(
  c: Context<{ Bindings: BffEnv }>,
  sessionCookieName: string,
  url: string,
  method: "DELETE" | "PATCH" | "POST" = "DELETE",
): Promise<Response> {
  const res = await fetchWithAuth(c, sessionCookieName, url, {
    method,
    headers: { Origin: c.env.IDP_ORIGIN },
  });
  return proxyResponse(res);
}

/**
 * OAuth stateパラメータをCookieに保存する（BFFログイン・リンク開始時に使用）。
 */
export function setOAuthStateCookie(
  c: Context<{ Bindings: BffEnv }>,
  cookieName: string,
  state: string,
): void {
  setCookie(c, cookieName, state, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 600,
  });
}

/**
 * OAuthコールバックでstateパラメータを検証し、state Cookieを消費する。
 * 成功時は null を返し、失敗時はエラーコードを返す。
 */
export function verifyAndConsumeOAuthState(
  c: Context<{ Bindings: BffEnv }>,
  stateCookieName: string,
  stateParam: string,
): "missing_session" | "state_mismatch" | null {
  const storedState = getCookie(c, stateCookieName);
  if (!storedState) return "missing_session";
  if (!timingSafeEqual(stateParam, storedState)) return "state_mismatch";
  deleteCookie(c, stateCookieName, { path: "/", secure: true });
  return null;
}

export interface ExchangeResult {
  access_token: string;
  refresh_token: string;
  /** BFF セッション ID（bff_sessions テーブルの行 ID）。BFF フロー時のみ設定される。 */
  session_id?: string;
  user: { id: string; email: string; name: string; role: "user" | "admin" };
}

/**
 * BFFからIdPへ認可コードを交換する。
 * Service Bindingsを使用してIdPのexchangeエンドポイントを呼び出す。
 */
export async function exchangeCodeAtIdp(
  env: BffEnv,
  code: string,
  callbackUrl: string,
): Promise<{ ok: true; data: ExchangeResult } | { ok: false }> {
  const res = await env.IDP.fetch(
    new Request(`${env.IDP_ORIGIN}/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...internalServiceHeaders(env) },
      body: JSON.stringify({ code, redirect_to: callbackUrl }),
    }),
  );
  logUpstreamDeprecation(res, { method: "POST", path: "/auth/exchange" });
  if (!res.ok) return { ok: false };
  const body = await res.json<{ data: ExchangeResult }>();
  return { ok: true, data: body.data };
}

/**
 * BFFからIdPへリフレッシュトークンの失効を要求する。
 * 通信エラーは呼び出し側で処理する。
 */
export async function revokeTokenAtIdp(
  env: BffEnv,
  refreshToken: string,
  sessionId?: string,
): Promise<void> {
  const res = await env.IDP.fetch(
    new Request(`${env.IDP_ORIGIN}/auth/logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...internalServiceHeaders(env) },
      body: JSON.stringify({
        refresh_token: refreshToken,
        ...(sessionId ? { session_id: sessionId } : {}),
      }),
    }),
  );
  logUpstreamDeprecation(res, { method: "POST", path: "/auth/logout" });
}

/**
 * BFF Worker の環境変数を検証する。
 * SESSION_SECRET が32文字未満の場合はエラーをスローする（AES-256-GCM鍵導出に十分なエントロピーが必要）。
 */
export function validateBffEnv(env: { SESSION_SECRET: string }): void {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
    throw new Error("SESSION_SECRET は32文字以上の安全なランダム値が必要です");
  }
}

import { type Context } from 'hono';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import type { BffEnv } from '../types';
import { decodeBase64Url } from './base64url';

export interface BffSession {
  access_token: string;
  refresh_token: string;
  user: { id: string; email: string; name: string; role: 'user' | 'admin' };
}

/**
 * BffSession の構造を実行時に検証する型ガード。
 * プロトタイプ汚染（JSON.parse による __proto__ インジェクション）への対策として、
 * 既知フィールドのみを明示的に検査する。
 */
function isBffSession(obj: unknown): obj is BffSession {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return false;
  const s = obj as Record<string, unknown>;
  if (typeof s['access_token'] !== 'string' || !s['access_token']) return false;
  if (typeof s['refresh_token'] !== 'string' || !s['refresh_token']) return false;
  if (typeof s['user'] !== 'object' || s['user'] === null || Array.isArray(s['user'])) return false;
  const u = s['user'] as Record<string, unknown>;
  if (typeof u['id'] !== 'string' || !u['id']) return false;
  if (typeof u['email'] !== 'string' || !u['email']) return false;
  if (typeof u['name'] !== 'string') return false;
  if (u['role'] !== 'user' && u['role'] !== 'admin') return false;
  return true;
}

/**
 * SESSION_SECRET から AES-256-GCM 鍵を導出する（HKDF-SHA256）。
 */
async function deriveAesKey(secret: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    'HKDF',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('0g0-id-bff-session-v1'),
      info: new TextEncoder().encode('bff-session'),
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * セッションCookieをパースしてBffSessionを返す。
 * AES-256-GCM で復号し、JSON.parse の結果を実行時バリデーションする。
 * 復号・パース失敗時は null を返す。
 */
export async function parseSession(
  cookie: string | undefined,
  secret: string
): Promise<BffSession | null> {
  if (!cookie) return null;
  try {
    // base64url → Uint8Array
    const combined = Uint8Array.from(decodeBase64Url(cookie), (c) => c.charCodeAt(0));

    if (combined.length < 13) return null; // 12バイトIV + 最低1バイト暗号文

    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);

    const key = await deriveAesKey(secret);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    const raw: unknown = JSON.parse(new TextDecoder().decode(plaintext));

    if (!isBffSession(raw)) return null;
    // 既知フィールドのみを抽出してプロトタイプ汚染を防止
    return {
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
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);

  // IV + 暗号文を結合して base64url エンコード
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(Array.from(combined, (b) => String.fromCharCode(b)).join(''))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * セッションCookieを30日間有効で設定する。
 */
export async function setSessionCookie(
  c: Context<{ Bindings: BffEnv }>,
  cookieName: string,
  session: BffSession
): Promise<void> {
  const encoded = await encodeSession(session, c.env.SESSION_SECRET);
  setCookie(c, cookieName, encoded, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * BFF→IdP間のService Bindings呼び出しに付与する内部認証ヘッダーを返す。
 * INTERNAL_SERVICE_SECRET が未設定の場合は空オブジェクトを返す。
 */
export function internalServiceHeaders(env: BffEnv): Record<string, string> {
  if (env.INTERNAL_SERVICE_SECRET) {
    return { 'X-Internal-Secret': env.INTERNAL_SERVICE_SECRET };
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
  init?: RequestInit
): Promise<Response> {
  const session = await parseSession(getCookie(c, sessionCookieName), c.env.SESSION_SECRET);
  if (!session) {
    return errorResponse(401, 'UNAUTHORIZED', 'Not authenticated');
  }

  const serviceHeaders = internalServiceHeaders(c.env);

  const makeRequest = (token: string): Promise<Response> =>
    c.env.IDP.fetch(
      new Request(url, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string> | undefined),
          ...serviceHeaders,
          Authorization: `Bearer ${token}`,
        },
      })
    );

  let res: Response;
  try {
    res = await makeRequest(session.access_token);
  } catch {
    return errorResponse(502, 'UPSTREAM_ERROR', 'Failed to reach identity provider');
  }

  // アクセストークン期限切れ → リフレッシュして再試行
  if (res.status === 401) {
    let refreshRes: Response;
    try {
      refreshRes = await c.env.IDP.fetch(
        new Request(`${c.env.IDP_ORIGIN}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...serviceHeaders },
          body: JSON.stringify({ refresh_token: session.refresh_token }),
        })
      );
    } catch {
      // リフレッシュ自体が通信失敗 → 502
      return errorResponse(502, 'UPSTREAM_ERROR', 'Failed to reach identity provider');
    }

    if (refreshRes.ok) {
      const refreshData = await refreshRes.json<{
        data: {
          access_token: string;
          refresh_token: string;
          user?: { id: string; email: string; name: string; role: 'user' | 'admin' };
        };
      }>();

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
        return errorResponse(502, 'UPSTREAM_ERROR', 'Failed to reach identity provider');
      }
    } else if (refreshRes.status >= 500) {
      // リフレッシュエンドポイントが5xx → 502（認証失敗ではなくアップストリーム障害）
      return errorResponse(502, 'UPSTREAM_ERROR', 'Identity provider error');
    } else {
      // 400/401: リフレッシュトークン無効/期限切れ → 無効セッションCookieを削除して401を返す
      deleteCookie(c, sessionCookieName, { path: '/', secure: true, httpOnly: true, sameSite: 'Lax' });
      return errorResponse(401, 'UNAUTHORIZED', 'Session expired');
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
  method: 'POST' | 'PATCH' | 'PUT' = 'POST'
): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return errorResponse(400, 'BAD_REQUEST', 'Invalid JSON body');
  }

  const res = await fetchWithAuth(c, sessionCookieName, url, {
    method,
    headers: {
      'Content-Type': 'application/json',
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
  const contentType = res.headers.get('Content-Type');
  if (contentType) safeHeaders.set('Content-Type', contentType);

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
  method: 'DELETE' | 'PATCH' | 'POST' = 'DELETE'
): Promise<Response> {
  const res = await fetchWithAuth(c, sessionCookieName, url, {
    method,
    headers: { Origin: c.env.IDP_ORIGIN },
  });
  return proxyResponse(res);
}

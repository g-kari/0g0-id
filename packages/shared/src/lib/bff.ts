import { type Context } from 'hono';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import type { BffEnv } from '../types';

export interface BffSession {
  access_token: string;
  refresh_token: string;
  user: { id: string; email: string; name: string; role: 'user' | 'admin' };
}

/**
 * セッションCookieをパースしてBffSessionを返す
 */
export function parseSession(cookie: string | undefined): BffSession | null {
  if (!cookie) return null;
  try {
    return JSON.parse(decodeURIComponent(atob(cookie)));
  } catch {
    return null;
  }
}

function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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
  const session = parseSession(getCookie(c, sessionCookieName));
  if (!session) {
    return errorResponse(401, 'UNAUTHORIZED', 'Not authenticated');
  }

  const makeRequest = (token: string): Promise<Response> =>
    c.env.IDP.fetch(
      new Request(url, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string> | undefined),
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
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: session.refresh_token }),
        })
      );
    } catch {
      // リフレッシュ自体が通信失敗 → 502
      return errorResponse(502, 'UPSTREAM_ERROR', 'Failed to reach identity provider');
    }

    if (refreshRes.ok) {
      const refreshData = await refreshRes.json<{
        data: { access_token: string; refresh_token: string };
      }>();

      // セッションCookieを新トークンで更新
      const newSession: BffSession = {
        ...session,
        access_token: refreshData.data.access_token,
        refresh_token: refreshData.data.refresh_token,
      };
      setCookie(c, sessionCookieName, btoa(encodeURIComponent(JSON.stringify(newSession))), {
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        path: '/',
        maxAge: 30 * 24 * 60 * 60,
      });

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
      deleteCookie(c, sessionCookieName, { path: '/', secure: true, httpOnly: true });
      return errorResponse(401, 'UNAUTHORIZED', 'Session expired');
    }
  }

  return res;
}

/**
 * IdPからのResponseをそのままBFFクライアントへ返すユーティリティ。
 * c.json() の `as 200` 型アサーション回避のため Response を直接構築する。
 * 204 No Content の場合は body なしで返す。
 */
export async function proxyResponse(res: Response): Promise<Response> {
  if (res.status === 204) {
    return new Response(null, { status: 204, headers: res.headers });
  }
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: res.headers,
  });
}

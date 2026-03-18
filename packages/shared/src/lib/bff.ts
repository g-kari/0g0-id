import { type Context } from 'hono';
import { setCookie, getCookie } from 'hono/cookie';
import type { BffEnv } from '../types';

export interface BffSession {
  access_token: string;
  refresh_token: string;
  user: { id: string; email: string; name: string; role: string };
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

/**
 * BFF→IdP へのリクエストをアクセストークン付きで実行する。
 * 401が返った場合はリフレッシュトークンで再取得してリトライする。
 * リフレッシュに成功した場合はセッションCookieも更新する。
 */
export async function fetchWithAuth(
  c: Context<{ Bindings: BffEnv }>,
  sessionCookieName: string,
  url: string,
  init?: RequestInit
): Promise<Response> {
  const session = parseSession(getCookie(c, sessionCookieName));
  if (!session) {
    return new Response(
      JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
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

  let res = await makeRequest(session.access_token);

  // アクセストークン期限切れ → リフレッシュして再試行
  if (res.status === 401) {
    const refreshRes = await c.env.IDP.fetch(
      new Request(`${c.env.IDP_ORIGIN}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refresh_token }),
      })
    );

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

      res = await makeRequest(refreshData.data.access_token);
    }
  }

  return res;
}

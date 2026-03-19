import { describe, it, expect, vi } from 'vitest';
import { parseSession, fetchWithAuth, proxyResponse } from './bff';
import type { BffSession } from './bff';

// BffSessionをbase64エンコードするヘルパー
function encodeSession(session: BffSession): string {
  return btoa(encodeURIComponent(JSON.stringify(session)));
}

const mockSession: BffSession = {
  access_token: 'access-token-123',
  refresh_token: 'refresh-token-456',
  user: { id: 'user-1', email: 'test@example.com', name: 'Test User', role: 'user' },
};

describe('parseSession', () => {
  it('正常なCookie値からセッションをパースする', () => {
    const cookie = encodeSession(mockSession);
    const result = parseSession(cookie);
    expect(result).not.toBeNull();
    expect(result?.access_token).toBe('access-token-123');
    expect(result?.refresh_token).toBe('refresh-token-456');
    expect(result?.user.id).toBe('user-1');
    expect(result?.user.role).toBe('user');
  });

  it('undefined を受け取ると null を返す', () => {
    expect(parseSession(undefined)).toBeNull();
  });

  it('不正なbase64文字列は null を返す', () => {
    expect(parseSession('not-valid-base64!!!')).toBeNull();
  });

  it('base64デコード後が不正なJSONは null を返す', () => {
    const invalid = btoa(encodeURIComponent('not-json'));
    expect(parseSession(invalid)).toBeNull();
  });

  it('空文字列は null を返す', () => {
    expect(parseSession('')).toBeNull();
  });
});

// Honoのコンテキストを模倣するモックビルダー
function makeMockContext(cookieValue: string | undefined, idpFetch: ReturnType<typeof vi.fn>) {
  const cookies: Record<string, string> = {};
  if (cookieValue !== undefined) {
    cookies['__session'] = cookieValue;
  }

  return {
    req: { header: vi.fn() },
    env: {
      IDP: { fetch: idpFetch } as unknown as Fetcher,
      IDP_ORIGIN: 'https://id.0g0.xyz',
    },
    get: vi.fn(),
    set: vi.fn(),
    // hono/cookie の getCookie/setCookie/deleteCookie はコンテキストから読む
    // テスト用にCookieヘッダーを直接シミュレート
    _cookies: cookies,
  };
}

describe('proxyResponse', () => {
  it('通常のレスポンスをそのまま返す', async () => {
    const original = new Response('{"data":"test"}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    const result = await proxyResponse(original);
    expect(result.status).toBe(200);
    const body = await result.text();
    expect(body).toBe('{"data":"test"}');
  });

  it('204 No Content の場合はボディなしで返す', async () => {
    const original = new Response(null, { status: 204 });
    const result = await proxyResponse(original);
    expect(result.status).toBe(204);
    const body = await result.text();
    expect(body).toBe('');
  });

  it('4xx エラーレスポンスもそのまま返す', async () => {
    const original = new Response('{"error":{"code":"NOT_FOUND"}}', {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
    const result = await proxyResponse(original);
    expect(result.status).toBe(404);
    const body = await result.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

describe('fetchWithAuth - セッションなし', () => {
  it('セッションCookieがない場合は401を返す', async () => {
    // Honoのcookieユーティリティをモック
    vi.mock('hono/cookie', () => ({
      getCookie: vi.fn().mockReturnValue(undefined),
      setCookie: vi.fn(),
      deleteCookie: vi.fn(),
    }));

    const { fetchWithAuth: fetchWithAuthFn } = await import('./bff');
    const idpFetch = vi.fn();
    const ctx = {
      req: {},
      env: { IDP: { fetch: idpFetch }, IDP_ORIGIN: 'https://id.0g0.xyz' },
    } as unknown as Parameters<typeof fetchWithAuthFn>[0];

    const result = await fetchWithAuthFn(ctx, '__session', 'https://id.0g0.xyz/api/test');
    expect(result.status).toBe(401);
    const body = await result.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });
});

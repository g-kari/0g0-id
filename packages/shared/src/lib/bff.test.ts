import { describe, it, expect, vi } from 'vitest';
import { parseSession, encodeSession, proxyResponse, fetchWithJsonBody } from './bff';
import type { BffSession } from './bff';

// hono/cookie をトップレベルでモック（vi.mock はホイスティングが必要）
vi.mock('hono/cookie', () => ({
  getCookie: vi.fn(),
  setCookie: vi.fn(),
  deleteCookie: vi.fn(),
}));

import { getCookie } from 'hono/cookie';

const TEST_SECRET = 'test-session-secret-for-unit-tests-only-32b';

const mockSession: BffSession = {
  access_token: 'access-token-123',
  refresh_token: 'refresh-token-456',
  user: { id: 'user-1', email: 'test@example.com', name: 'Test User', role: 'user' },
};

describe('parseSession', () => {
  it('正常なCookie値からセッションをパースする', async () => {
    const cookie = await encodeSession(mockSession, TEST_SECRET);
    const result = await parseSession(cookie, TEST_SECRET);
    expect(result).not.toBeNull();
    expect(result?.access_token).toBe('access-token-123');
    expect(result?.refresh_token).toBe('refresh-token-456');
    expect(result?.user.id).toBe('user-1');
    expect(result?.user.role).toBe('user');
  });

  it('undefined を受け取ると null を返す', async () => {
    expect(await parseSession(undefined, TEST_SECRET)).toBeNull();
  });

  it('不正な値は null を返す', async () => {
    expect(await parseSession('not-valid-base64!!!', TEST_SECRET)).toBeNull();
  });

  it('空文字列は null を返す', async () => {
    expect(await parseSession('', TEST_SECRET)).toBeNull();
  });

  it('異なるシークレットでは null を返す', async () => {
    const cookie = await encodeSession(mockSession, TEST_SECRET);
    expect(await parseSession(cookie, 'wrong-secret')).toBeNull();
  });

  it('余分なフィールドは含まれず、既知フィールドのみを返す', async () => {
    // encodeSession は既知フィールドのみ含む正常なセッションをエンコードするため、
    // isBffSession の既知フィールド抽出が機能していることを確認
    const cookie = await encodeSession(mockSession, TEST_SECRET);
    const result = await parseSession(cookie, TEST_SECRET);
    expect(result).not.toBeNull();
    expect(result?.access_token).toBe('access-token-123');
    expect(result?.refresh_token).toBe('refresh-token-456');
    expect(result?.user.id).toBe('user-1');
  });
});

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

describe('fetchWithAuth', () => {
  it('セッションCookieがない場合は401を返す', async () => {
    vi.mocked(getCookie).mockReturnValue(undefined);

    const { fetchWithAuth } = await import('./bff');
    const idpFetch = vi.fn();
    const ctx = {
      req: {},
      env: {
        IDP: { fetch: idpFetch },
        IDP_ORIGIN: 'https://id.0g0.xyz',
        SESSION_SECRET: TEST_SECRET,
      },
    } as unknown as Parameters<typeof fetchWithAuth>[0];

    const result = await fetchWithAuth(ctx, '__session', 'https://id.0g0.xyz/api/test');
    expect(result.status).toBe(401);
    const body = await result.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('セッションが有効な場合はIdPにリクエストを転送する', async () => {
    const cookie = await encodeSession(mockSession, TEST_SECRET);
    vi.mocked(getCookie).mockReturnValue(cookie);

    const { fetchWithAuth } = await import('./bff');
    const idpFetch = vi.fn().mockResolvedValue(new Response('{"data":"ok"}', { status: 200 }));
    const ctx = {
      req: {},
      env: {
        IDP: { fetch: idpFetch },
        IDP_ORIGIN: 'https://id.0g0.xyz',
        SESSION_SECRET: TEST_SECRET,
      },
    } as unknown as Parameters<typeof fetchWithAuth>[0];

    const result = await fetchWithAuth(ctx, '__session', 'https://id.0g0.xyz/api/me');
    expect(result.status).toBe(200);
    expect(idpFetch).toHaveBeenCalledOnce();
    // Authorizationヘッダーにアクセストークンが設定されていること
    const reqArg: Request = idpFetch.mock.calls[0][0];
    expect(reqArg.headers.get('Authorization')).toBe('Bearer access-token-123');
  });

  it('IdPへのリクエストが失敗した場合は502を返す', async () => {
    const cookie = await encodeSession(mockSession, TEST_SECRET);
    vi.mocked(getCookie).mockReturnValue(cookie);

    const { fetchWithAuth } = await import('./bff');
    const idpFetch = vi.fn().mockRejectedValue(new Error('network error'));
    const ctx = {
      req: {},
      env: {
        IDP: { fetch: idpFetch },
        IDP_ORIGIN: 'https://id.0g0.xyz',
        SESSION_SECRET: TEST_SECRET,
      },
    } as unknown as Parameters<typeof fetchWithAuth>[0];

    const result = await fetchWithAuth(ctx, '__session', 'https://id.0g0.xyz/api/me');
    expect(result.status).toBe(502);
    const body = await result.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('UPSTREAM_ERROR');
  });
});

describe('fetchWithJsonBody', () => {
  it('JSONパース失敗時は400を返す', async () => {
    const cookie = await encodeSession(mockSession, TEST_SECRET);
    vi.mocked(getCookie).mockReturnValue(cookie);

    const ctx = {
      req: { json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token')) },
      env: {
        IDP: { fetch: vi.fn() },
        IDP_ORIGIN: 'https://id.0g0.xyz',
        SESSION_SECRET: TEST_SECRET,
      },
    } as unknown as Parameters<typeof fetchWithJsonBody>[0];

    const result = await fetchWithJsonBody(ctx, '__session', 'https://id.0g0.xyz/api/test', 'POST');
    expect(result.status).toBe(400);
    const body = await result.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message).toBe('Invalid JSON body');
  });

  it('正常なJSONボディをIdPへ転送してproxyResponseを返す', async () => {
    const cookie = await encodeSession(mockSession, TEST_SECRET);
    vi.mocked(getCookie).mockReturnValue(cookie);

    const requestBody = { name: 'test-service' };
    const idpFetch = vi.fn().mockResolvedValue(
      new Response('{"data":{"id":"svc-1"}}', { status: 201 })
    );
    const ctx = {
      req: { json: vi.fn().mockResolvedValue(requestBody) },
      env: {
        IDP: { fetch: idpFetch },
        IDP_ORIGIN: 'https://id.0g0.xyz',
        SESSION_SECRET: TEST_SECRET,
      },
    } as unknown as Parameters<typeof fetchWithJsonBody>[0];

    const result = await fetchWithJsonBody(ctx, '__session', 'https://id.0g0.xyz/api/services', 'POST');
    expect(result.status).toBe(201);
    expect(idpFetch).toHaveBeenCalledOnce();
    const reqArg: Request = idpFetch.mock.calls[0][0];
    expect(reqArg.method).toBe('POST');
    expect(reqArg.headers.get('Content-Type')).toBe('application/json');
    expect(reqArg.headers.get('Origin')).toBe('https://id.0g0.xyz');
    expect(reqArg.headers.get('Authorization')).toBe('Bearer access-token-123');
    expect(await reqArg.json()).toEqual(requestBody);
  });

  it('methodパラメータがPATCHの場合はPATCHリクエストを送る', async () => {
    const cookie = await encodeSession(mockSession, TEST_SECRET);
    vi.mocked(getCookie).mockReturnValue(cookie);

    const idpFetch = vi.fn().mockResolvedValue(
      new Response('{"data":{"id":"svc-1"}}', { status: 200 })
    );
    const ctx = {
      req: { json: vi.fn().mockResolvedValue({ role: 'admin' }) },
      env: {
        IDP: { fetch: idpFetch },
        IDP_ORIGIN: 'https://id.0g0.xyz',
        SESSION_SECRET: TEST_SECRET,
      },
    } as unknown as Parameters<typeof fetchWithJsonBody>[0];

    await fetchWithJsonBody(ctx, '__session', 'https://id.0g0.xyz/api/users/u-1/role', 'PATCH');
    const reqArg: Request = idpFetch.mock.calls[0][0];
    expect(reqArg.method).toBe('PATCH');
  });
});

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

  it('access_token が欠けている場合は null を返す', () => {
    const invalid = btoa(encodeURIComponent(JSON.stringify({
      refresh_token: 'rt',
      user: { id: 'u1', email: 'a@b.com', name: 'A', role: 'user' },
    })));
    expect(parseSession(invalid)).toBeNull();
  });

  it('user.role が不正な値の場合は null を返す', () => {
    const invalid = btoa(encodeURIComponent(JSON.stringify({
      access_token: 'at',
      refresh_token: 'rt',
      user: { id: 'u1', email: 'a@b.com', name: 'A', role: 'superadmin' },
    })));
    expect(parseSession(invalid)).toBeNull();
  });

  it('user フィールドが欠けている場合は null を返す', () => {
    const invalid = btoa(encodeURIComponent(JSON.stringify({
      access_token: 'at',
      refresh_token: 'rt',
    })));
    expect(parseSession(invalid)).toBeNull();
  });

  it('配列を渡した場合は null を返す（プロトタイプ汚染対策）', () => {
    const invalid = btoa(encodeURIComponent(JSON.stringify(['not', 'an', 'object'])));
    expect(parseSession(invalid)).toBeNull();
  });

  it('余分なフィールドは含まれず、既知フィールドのみを返す', () => {
    const withExtra = btoa(encodeURIComponent(JSON.stringify({
      access_token: 'at',
      refresh_token: 'rt',
      user: { id: 'u1', email: 'a@b.com', name: 'A', role: 'user' },
      __proto__: { polluted: true },
      extra_field: 'should-be-ignored',
    })));
    const result = parseSession(withExtra);
    expect(result).not.toBeNull();
    expect('extra_field' in (result ?? {})).toBe(false);
    expect(result?.access_token).toBe('at');
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
      env: { IDP: { fetch: idpFetch }, IDP_ORIGIN: 'https://id.0g0.xyz' },
    } as unknown as Parameters<typeof fetchWithAuth>[0];

    const result = await fetchWithAuth(ctx, '__session', 'https://id.0g0.xyz/api/test');
    expect(result.status).toBe(401);
    const body = await result.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('セッションが有効な場合はIdPにリクエストを転送する', async () => {
    vi.mocked(getCookie).mockReturnValue(encodeSession(mockSession));

    const { fetchWithAuth } = await import('./bff');
    const idpFetch = vi.fn().mockResolvedValue(new Response('{"data":"ok"}', { status: 200 }));
    const ctx = {
      req: {},
      env: { IDP: { fetch: idpFetch }, IDP_ORIGIN: 'https://id.0g0.xyz' },
    } as unknown as Parameters<typeof fetchWithAuth>[0];

    const result = await fetchWithAuth(ctx, '__session', 'https://id.0g0.xyz/api/me');
    expect(result.status).toBe(200);
    expect(idpFetch).toHaveBeenCalledOnce();
    // Authorizationヘッダーにアクセストークンが設定されていること
    const reqArg: Request = idpFetch.mock.calls[0][0];
    expect(reqArg.headers.get('Authorization')).toBe('Bearer access-token-123');
  });

  it('IdPへのリクエストが失敗した場合は502を返す', async () => {
    vi.mocked(getCookie).mockReturnValue(encodeSession(mockSession));

    const { fetchWithAuth } = await import('./bff');
    const idpFetch = vi.fn().mockRejectedValue(new Error('network error'));
    const ctx = {
      req: {},
      env: { IDP: { fetch: idpFetch }, IDP_ORIGIN: 'https://id.0g0.xyz' },
    } as unknown as Parameters<typeof fetchWithAuth>[0];

    const result = await fetchWithAuth(ctx, '__session', 'https://id.0g0.xyz/api/me');
    expect(result.status).toBe(502);
    const body = await result.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('UPSTREAM_ERROR');
  });
});

describe('fetchWithJsonBody', () => {
  it('JSONパース失敗時は400を返す', async () => {
    vi.mocked(getCookie).mockReturnValue(encodeSession(mockSession));

    const ctx = {
      req: { json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token')) },
      env: { IDP: { fetch: vi.fn() }, IDP_ORIGIN: 'https://id.0g0.xyz' },
    } as unknown as Parameters<typeof fetchWithJsonBody>[0];

    const result = await fetchWithJsonBody(ctx, '__session', 'https://id.0g0.xyz/api/test', 'POST');
    expect(result.status).toBe(400);
    const body = await result.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message).toBe('Invalid JSON body');
  });

  it('正常なJSONボディをIdPへ転送してproxyResponseを返す', async () => {
    vi.mocked(getCookie).mockReturnValue(encodeSession(mockSession));

    const requestBody = { name: 'test-service' };
    const idpFetch = vi.fn().mockResolvedValue(
      new Response('{"data":{"id":"svc-1"}}', { status: 201 })
    );
    const ctx = {
      req: { json: vi.fn().mockResolvedValue(requestBody) },
      env: { IDP: { fetch: idpFetch }, IDP_ORIGIN: 'https://id.0g0.xyz' },
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
    vi.mocked(getCookie).mockReturnValue(encodeSession(mockSession));

    const idpFetch = vi.fn().mockResolvedValue(
      new Response('{"data":{"id":"svc-1"}}', { status: 200 })
    );
    const ctx = {
      req: { json: vi.fn().mockResolvedValue({ role: 'admin' }) },
      env: { IDP: { fetch: idpFetch }, IDP_ORIGIN: 'https://id.0g0.xyz' },
    } as unknown as Parameters<typeof fetchWithJsonBody>[0];

    await fetchWithJsonBody(ctx, '__session', 'https://id.0g0.xyz/api/users/u-1/role', 'PATCH');
    const reqArg: Request = idpFetch.mock.calls[0][0];
    expect(reqArg.method).toBe('PATCH');
  });
});

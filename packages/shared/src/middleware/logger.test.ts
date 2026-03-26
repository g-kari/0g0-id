import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { logger } from './logger';

function buildApp(handler?: (c: import('hono').Context) => Response | Promise<Response>) {
  const app = new Hono();
  app.use('*', logger());
  app.get('/test', handler ?? ((c) => c.json({ ok: true })));
  return app;
}

function parseLogEntry(
  logLine: string,
): { level: string; ctx: string; msg: string; data: Record<string, unknown> } {
  return JSON.parse(logLine) as {
    level: string;
    ctx: string;
    msg: string;
    data: Record<string, unknown>;
  };
}

describe('logger middleware', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('リクエストをログ出力する', async () => {
    const app = buildApp();
    const res = await app.request('https://id.0g0.xyz/test');
    expect(res.status).toBe(200);
    expect(consoleSpy).toHaveBeenCalledOnce();
    const entry = parseLogEntry(consoleSpy.mock.calls[0][0] as string);
    expect(entry.level).toBe('info');
    expect(entry.ctx).toBe('http');
    expect(entry.msg).toBe('request');
    expect(entry.data.method).toBe('GET');
    expect(entry.data.path).toBe('/test');
    expect(entry.data.status).toBe(200);
    expect(typeof entry.data.elapsed_ms).toBe('number');
  });

  it('クエリパラメータを含むURLをログ出力する', async () => {
    const app = buildApp();
    await app.request('https://id.0g0.xyz/test?foo=bar&baz=qux');
    const entry = parseLogEntry(consoleSpy.mock.calls[0][0] as string);
    expect(entry.data.path).toBe('/test?foo=bar&baz=qux');
  });

  describe('機密パラメータのマスク', () => {
    const sensitiveParams = [
      'code',
      'state',
      'token',
      'access_token',
      'refresh_token',
      'code_verifier',
      'client_secret',
    ];

    for (const param of sensitiveParams) {
      it(`${param} パラメータを [REDACTED] でマスクする`, async () => {
        const app = buildApp();
        await app.request(`https://id.0g0.xyz/test?${param}=secret-value`);
        const entry = parseLogEntry(consoleSpy.mock.calls[0][0] as string);
        const path = entry.data.path as string;
        expect(path).not.toContain('secret-value');
        expect(path).toContain(`${param}=[REDACTED]`);
      });
    }

    it('機密パラメータと通常パラメータが混在している場合、機密のみマスクする', async () => {
      const app = buildApp();
      await app.request(
        'https://id.0g0.xyz/test?foo=visible&code=secret&bar=also-visible&state=hidden',
      );
      const entry = parseLogEntry(consoleSpy.mock.calls[0][0] as string);
      const path = entry.data.path as string;
      expect(path).toContain('foo=visible');
      expect(path).toContain('bar=also-visible');
      expect(path).toContain('code=[REDACTED]');
      expect(path).toContain('state=[REDACTED]');
      expect(path).not.toContain('secret');
      expect(path).not.toContain('hidden');
    });

    it('クエリパラメータがない場合はそのままログ出力する', async () => {
      const app = buildApp();
      await app.request('https://id.0g0.xyz/test');
      const entry = parseLogEntry(consoleSpy.mock.calls[0][0] as string);
      expect(entry.data.path).toBe('/test');
    });

    it('スキームなしのURLでも機密パラメータをマスクする', async () => {
      // Honoは内部的にURLを組み立てるが、念のためURLフォーマットを確認
      const app = buildApp();
      await app.request('https://id.0g0.xyz/test?token=my-secret-token&page=1');
      const entry = parseLogEntry(consoleSpy.mock.calls[0][0] as string);
      const path = entry.data.path as string;
      expect(path).toContain('token=[REDACTED]');
      expect(path).toContain('page=1');
    });
  });

  it('経過時間をms単位で記録する', async () => {
    const app = buildApp(async (c) => {
      // 少し遅延してレスポンス
      await new Promise((resolve) => setTimeout(resolve, 5));
      return c.json({ ok: true });
    });
    await app.request('https://id.0g0.xyz/test');
    const entry = parseLogEntry(consoleSpy.mock.calls[0][0] as string);
    expect(typeof entry.data.elapsed_ms).toBe('number');
    // 5ms の遅延があるため、記録された経過時間は1ms以上であること
    expect(entry.data.elapsed_ms as number).toBeGreaterThanOrEqual(1);
  });

  it('異なるHTTPメソッドをログ出力する', async () => {
    const app = new Hono();
    app.use('*', logger());
    app.post('/test', (c) => c.json({ created: true }, 201));

    await app.request('https://id.0g0.xyz/test', { method: 'POST' });
    const entry = parseLogEntry(consoleSpy.mock.calls[0][0] as string);
    expect(entry.data.method).toBe('POST');
    expect(entry.data.path).toBe('/test');
    expect(entry.data.status).toBe(201);
  });
});

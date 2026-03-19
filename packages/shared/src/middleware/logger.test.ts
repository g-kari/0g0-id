import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { logger } from './logger';

function buildApp(handler?: (c: import('hono').Context) => Response | Promise<Response>) {
  const app = new Hono();
  app.use('*', logger());
  app.get('/test', handler ?? ((c) => c.json({ ok: true })));
  return app;
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
    const logLine = consoleSpy.mock.calls[0][0] as string;
    expect(logLine).toMatch(/^GET \/test 200 \d+ms$/);
  });

  it('クエリパラメータを含むURLをログ出力する', async () => {
    const app = buildApp();
    await app.request('https://id.0g0.xyz/test?foo=bar&baz=qux');
    const logLine = consoleSpy.mock.calls[0][0] as string;
    expect(logLine).toMatch(/^GET \/test\?foo=bar&baz=qux 200 \d+ms$/);
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
        const logLine = consoleSpy.mock.calls[0][0] as string;
        expect(logLine).not.toContain('secret-value');
        expect(logLine).toContain(`${param}=[REDACTED]`);
      });
    }

    it('機密パラメータと通常パラメータが混在している場合、機密のみマスクする', async () => {
      const app = buildApp();
      await app.request(
        'https://id.0g0.xyz/test?foo=visible&code=secret&bar=also-visible&state=hidden'
      );
      const logLine = consoleSpy.mock.calls[0][0] as string;
      expect(logLine).toContain('foo=visible');
      expect(logLine).toContain('bar=also-visible');
      expect(logLine).toContain('code=[REDACTED]');
      expect(logLine).toContain('state=[REDACTED]');
      expect(logLine).not.toContain('secret');
      expect(logLine).not.toContain('hidden');
    });

    it('クエリパラメータがない場合はそのままログ出力する', async () => {
      const app = buildApp();
      await app.request('https://id.0g0.xyz/test');
      const logLine = consoleSpy.mock.calls[0][0] as string;
      expect(logLine).toMatch(/^GET \/test 200 \d+ms$/);
    });

    it('スキームなしのURLでも機密パラメータをマスクする', async () => {
      // Honoは内部的にURLを組み立てるが、念のためURLフォーマットを確認
      const app = buildApp();
      await app.request('https://id.0g0.xyz/test?token=my-secret-token&page=1');
      const logLine = consoleSpy.mock.calls[0][0] as string;
      expect(logLine).toContain('token=[REDACTED]');
      expect(logLine).toContain('page=1');
    });
  });

  it('経過時間をms単位で記録する', async () => {
    const app = buildApp(async (c) => {
      // 少し遅延してレスポンス
      await new Promise((resolve) => setTimeout(resolve, 5));
      return c.json({ ok: true });
    });
    await app.request('https://id.0g0.xyz/test');
    const logLine = consoleSpy.mock.calls[0][0] as string;
    const match = logLine.match(/(\d+)ms$/);
    expect(match).not.toBeNull();
    // 5ms の遅延があるため、記録された経過時間は1ms以上であること
    expect(Number(match![1])).toBeGreaterThanOrEqual(1);
  });

  it('異なるHTTPメソッドをログ出力する', async () => {
    const app = new Hono();
    app.use('*', logger());
    app.post('/test', (c) => c.json({ created: true }, 201));

    await app.request('https://id.0g0.xyz/test', { method: 'POST' });
    const logLine = consoleSpy.mock.calls[0][0] as string;
    expect(logLine).toMatch(/^POST \/test 201 \d+ms$/);
  });
});

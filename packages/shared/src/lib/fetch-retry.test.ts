import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchWithRetry } from './fetch-retry';

describe('fetchWithRetry', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    // setTimeout をすぐに実行するモックに置き換える（バックオフ待機をスキップ）
    vi.stubGlobal(
      'setTimeout',
      (fn: () => void) => {
        fn();
        return 0;
      }
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('正常レスポンス時は即座に返す', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('OK', { status: 200 }));

    const result = await fetchWithRetry('https://example.com', {});
    expect(result.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('4xx エラーはリトライせず即座に返す', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('Bad Request', { status: 400 }));

    const result = await fetchWithRetry('https://example.com', {});
    expect(result.status).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('5xx エラーは最大3回試行して例外を投げる', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('Server Error', { status: 500 }));

    await expect(fetchWithRetry('https://example.com', {})).rejects.toThrow('HTTP 500');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('429 Too Many Requests はリトライして例外を投げる', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('Rate Limited', { status: 429 }));

    await expect(fetchWithRetry('https://example.com', {})).rejects.toThrow('HTTP 429');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('最初の試行が失敗してもリトライで成功する', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('Server Error', { status: 500 }))
      .mockResolvedValueOnce(new Response('OK', { status: 200 }));

    const result = await fetchWithRetry('https://example.com', {});
    expect(result.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('maxAttempts=1 の場合はリトライしない', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('Server Error', { status: 500 }));

    await expect(fetchWithRetry('https://example.com', {}, 1)).rejects.toThrow('HTTP 500');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('指定したURL・オプションでfetchを呼ぶ', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('OK', { status: 200 }));

    const options: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"key":"value"}',
    };
    await fetchWithRetry('https://api.example.com/data', options);

    expect(fetch).toHaveBeenCalledWith('https://api.example.com/data', options);
  });

  it('fetchが例外をスローした場合もリトライする', async () => {
    vi.mocked(fetch)
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce(new Response('OK', { status: 200 }));

    const result = await fetchWithRetry('https://example.com', {});
    expect(result.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('fetchが繰り返し例外をスローした場合は network error を投げる', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network error'));

    await expect(fetchWithRetry('https://example.com', {})).rejects.toThrow('network error');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('fetchが非Errorオブジェクトをスローした場合は Network error を投げる', async () => {
    vi.mocked(fetch).mockRejectedValue('raw string error');

    await expect(fetchWithRetry('https://example.com', {})).rejects.toThrow('Network error');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  describe('Retry-After ヘッダー', () => {
    it('秒数形式の Retry-After をバックオフ遅延として使用する', async () => {
      const delays: number[] = [];
      vi.stubGlobal('setTimeout', (fn: () => void, delay: number) => {
        delays.push(delay);
        fn();
        return 0;
      });

      vi.mocked(fetch)
        .mockResolvedValueOnce(
          new Response('Rate Limited', {
            status: 429,
            headers: { 'Retry-After': '5' },
          })
        )
        .mockResolvedValueOnce(new Response('OK', { status: 200 }));

      const result = await fetchWithRetry('https://example.com', {});
      expect(result.status).toBe(200);
      expect(delays[0]).toBe(5000);
    });

    it('Retry-After が大きすぎる場合は 60,000ms にキャップされる', async () => {
      const delays: number[] = [];
      vi.stubGlobal('setTimeout', (fn: () => void, delay: number) => {
        delays.push(delay);
        fn();
        return 0;
      });

      vi.mocked(fetch)
        .mockResolvedValueOnce(
          new Response('Rate Limited', {
            status: 429,
            headers: { 'Retry-After': '9999' },
          })
        )
        .mockResolvedValueOnce(new Response('OK', { status: 200 }));

      await fetchWithRetry('https://example.com', {});
      expect(delays[0]).toBe(60_000);
    });

    it('Retry-After が無効な値の場合はバックオフ遅延にフォールバックする', async () => {
      const delays: number[] = [];
      vi.stubGlobal('setTimeout', (fn: () => void, delay: number) => {
        delays.push(delay);
        fn();
        return 0;
      });

      vi.mocked(fetch)
        .mockResolvedValueOnce(
          new Response('Rate Limited', {
            status: 429,
            headers: { 'Retry-After': 'invalid-value' },
          })
        )
        .mockResolvedValueOnce(new Response('OK', { status: 200 }));

      await fetchWithRetry('https://example.com', {});
      expect(delays[0]).toBeGreaterThan(0);
      expect(delays[0]).toBeLessThanOrEqual(500);
    });
  });
});

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
});

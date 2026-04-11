const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * ジッター付き指数バックオフ遅延を計算する
 * Cloudflareのマルチインスタンス環境でのサンダリングハード問題を回避するためジッターを付与する
 */
function calcBackoffDelay(attempt: number): number {
  const base = 2 ** (attempt - 1) * BASE_DELAY_MS;
  return Math.floor(base * (0.5 + Math.random() * 0.5));
}

/**
 * Retry-Afterヘッダーをミリ秒に変換する
 * 秒数形式（例: "30"）またはHTTP-date形式（例: "Wed, 21 Oct 2015 07:28:00 GMT"）に対応
 */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = parseInt(header, 10);
  if (!isNaN(seconds)) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  const date = new Date(header);
  if (!isNaN(date.getTime())) {
    return Math.min(Math.max(0, date.getTime() - Date.now()), MAX_RETRY_AFTER_MS);
  }
  return null;
}

/**
 * 指数バックオフ + ジッター付きでリトライ可能なfetchを実行する
 * - 一時障害（5xx）と429に対してリトライを行う
 * - ネットワークエラー（fetchが例外をスロー）もリトライ対象
 * - 429のRetry-Afterヘッダーが存在する場合はその値をバックオフより優先する
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxAttempts = MAX_ATTEMPTS,
): Promise<Response> {
  let lastError: Error = new Error("Fetch failed");
  let retryAfterMs: number | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const delay = retryAfterMs ?? calcBackoffDelay(attempt);
      retryAfterMs = null;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    try {
      const response = await fetch(url, options);
      if (response.status !== 429 && response.status < 500) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status}`);
      if (response.status === 429) {
        retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
      }
    } catch (e) {
      lastError = e instanceof Error ? e : new Error("Network error");
    }
  }
  throw lastError;
}

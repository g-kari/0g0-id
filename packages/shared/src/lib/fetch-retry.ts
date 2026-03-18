const MAX_ATTEMPTS = 3;

/**
 * 指数バックオフ付きでリトライ可能なfetchを実行する
 * 一時障害（5xx）や429に対してリトライを行う
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxAttempts = MAX_ATTEMPTS
): Promise<Response> {
  let lastError: Error = new Error('Fetch failed');
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 2 ** (attempt - 1) * 500));
    }
    const response = await fetch(url, options);
    if (response.status !== 429 && response.status < 500) {
      return response;
    }
    lastError = new Error(`HTTP ${response.status}`);
  }
  throw lastError;
}

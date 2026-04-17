type ApiError = { error: { code: string; message: string } };

function isTokenRotatedBody(body: unknown): body is ApiError {
  return (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof (body as { error?: unknown }).error === "object" &&
    (body as ApiError).error?.code === "TOKEN_ROTATED"
  );
}

async function doFetch(path: string, options?: RequestInit): Promise<Response> {
  return fetch(path, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers as Record<string, string> | undefined),
    },
    ...options,
  });
}

export async function apiFetch<T>(
  path: string,
  options?: RequestInit,
): Promise<T | { error: { code: string; message: string } }> {
  let res = await doFetch(path, options);

  // 503 TOKEN_ROTATED: 並行リクエスト競合で BFF がローテーション中。
  // セッションは有効なので短い遅延後に 1 度だけ自動リトライする。
  if (res.status === 503) {
    const peek = await res
      .clone()
      .json()
      .catch(() => null);
    if (isTokenRotatedBody(peek)) {
      await new Promise((r) => setTimeout(r, 400));
      res = await doFetch(path, options);
    }
  }

  if (res.status === 401) {
    window.location.href = "/";
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const body = await (res.json() as Promise<{ error?: { message?: string } }>).catch(
      (): { error?: { message?: string } } => ({}),
    );
    return { error: { code: "HTTP_ERROR", message: body?.error?.message ?? `HTTP ${res.status}` } };
  }
  if (res.status === 204) {
    return {} as T;
  }
  const body = await res.json();
  // IdP API は { data: ... } 形式でレスポンスを返すため data をアンラップ
  if (body && typeof body === "object" && "data" in body) {
    return body.data as T;
  }
  return body as T;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

export function formatDatetime(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

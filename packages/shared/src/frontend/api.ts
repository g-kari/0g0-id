type ApiError = { error: { code: string; message: string } };
type ErrorBody = { error?: { message?: string; code?: string } };

function isApiErrorWithCode(body: unknown, code: string): body is ApiError {
  if (typeof body !== "object" || body === null) return false;
  const err = (body as { error?: unknown }).error;
  if (typeof err !== "object" || err === null) return false;
  return (err as { code?: unknown }).code === code;
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

// DBSC 再バインドを Chrome に任せるための待機時間（ms）。
// fTPM 環境では registration JWT 署名に 1s 以上かかるケースがあるため、
// 指数的に延ばして 2 回までリトライする。
const DBSC_REBIND_RETRY_DELAYS_MS = [500, 1500];

async function retryAfterDbscRebind(
  path: string,
  options: RequestInit | undefined,
  firstResponse: Response,
): Promise<Response> {
  if (!firstResponse.headers.get("Secure-Session-Registration")) {
    console.warn(
      "[DBSC] 403 DBSC_BINDING_REQUIRED without Secure-Session-Registration header; browser likely non-compliant",
    );
    return firstResponse;
  }

  let res = firstResponse;
  for (const delay of DBSC_REBIND_RETRY_DELAYS_MS) {
    await new Promise((r) => setTimeout(r, delay));
    res = await doFetch(path, options);
    if (res.status !== 403) return res;
    const peek = await res
      .clone()
      .json()
      .catch(() => null);
    if (!isApiErrorWithCode(peek, "DBSC_BINDING_REQUIRED")) return res;
  }
  return res;
}

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  let res = await doFetch(path, options);

  if (res.status === 503) {
    const peek = await res
      .clone()
      .json()
      .catch(() => null);
    if (isApiErrorWithCode(peek, "TOKEN_ROTATED")) {
      await new Promise((r) => setTimeout(r, 400));
      res = await doFetch(path, options);
    }
  }

  if (res.status === 403) {
    const peek = await res
      .clone()
      .json()
      .catch(() => null);
    if (isApiErrorWithCode(peek, "DBSC_BINDING_REQUIRED")) {
      res = await retryAfterDbscRebind(path, options, res);
    }
  }

  if (res.status === 401) {
    window.location.href = "/";
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const body = await (res.json() as Promise<ErrorBody>).catch((): ErrorBody => ({}));
    if (body?.error?.code === "DBSC_BINDING_REQUIRED") {
      throw new Error(
        "端末の確認が必要です。Chrome で一度ログアウトし、再度ログインしてください。",
      );
    }
    throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  const body = (await res.json()) as { data: T };
  return body.data;
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

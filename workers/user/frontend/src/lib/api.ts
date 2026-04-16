export async function apiFetch<T>(
  path: string,
  options?: RequestInit,
): Promise<T | { error: { code: string; message: string } }> {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers as Record<string, string> | undefined),
    },
    ...options,
  });
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

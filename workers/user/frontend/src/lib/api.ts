// API fetch ヘルパー

export async function apiFetch<T>(
  path: string,
  options?: RequestInit,
): Promise<{ data: T } | { error: { code: string; message: string } }> {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers as Record<string, string> | undefined),
    },
    ...options,
  });

  if (res.status === 401) {
    if (typeof window !== "undefined") window.location.href = "/";
    return { error: { code: "UNAUTHORIZED", message: "Unauthorized" } };
  }

  return res.json();
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ja-JP");
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

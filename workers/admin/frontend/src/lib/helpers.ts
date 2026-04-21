export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (ch) =>
      (
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }) as Record<string, string>
      )[ch]!,
  );
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "\u2026" : s;
}

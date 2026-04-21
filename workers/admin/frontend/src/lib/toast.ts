export function showToast(msg: string, type: "success" | "error" = "success"): void {
  const el = document.createElement("div");
  el.textContent = msg;
  el.style.cssText = `position:fixed;bottom:20px;right:20px;padding:10px 16px;border-radius:8px;color:#fff;font-size:0.875rem;z-index:9999;background:${type === "error" ? "var(--color-danger,#e53e3e)" : "var(--color-success,#38a169)"}`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

type CopyElements = {
  button: HTMLButtonElement;
  recovery: HTMLElement;
  input: HTMLInputElement;
  status: HTMLElement;
};

/** Copy an already displayed subject; never request additional clipboard permissions. */
export function setupConnectionCopy(elements: CopyElements, copied: () => void): void {
  let pending = false;
  const value = elements.input.value;
  elements.button.addEventListener("click", async (): Promise<void> => {
    if (pending) return;
    pending = true;
    elements.button.disabled = true;
    elements.button.setAttribute("aria-busy", "true");
    try {
      await navigator.clipboard.writeText(value);
      elements.status.textContent = "Sub ID をコピーしました。";
      if (document.activeElement !== elements.input) elements.recovery.hidden = true;
      copied();
    } catch {
      elements.recovery.hidden = false;
      elements.input.value = value;
      elements.status.textContent =
        "コピーできませんでした。手動コピー用の Sub ID を選択してコピーしてください。アクセス権の変更は不要です。";
      // Do not steal focus if the person moved elsewhere while the clipboard settled.
      if (
        elements.button.isConnected &&
        (document.activeElement === elements.button || document.activeElement === document.body)
      ) {
        elements.input.focus();
        elements.input.select();
      }
    } finally {
      pending = false;
      elements.button.disabled = false;
      elements.button.removeAttribute("aria-busy");
    }
  });
}

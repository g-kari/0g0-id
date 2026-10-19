// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { setupConnectionCopy } from "../connection-copy";

const sub = "synthetic-sub-" + "a".repeat(64);
const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("connection subject copy recovery", () => {
  let button: HTMLButtonElement;
  let recovery: HTMLElement;
  let input: HTMLInputElement;
  let status: HTMLElement;
  let copied: ReturnType<typeof vi.fn<() => void>>;
  let writeText: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    document.body.innerHTML =
      '<button>コピー</button><div hidden><label>Sub ID（手動コピー用）<input readonly></label></div><p role="status" aria-live="polite"></p><a href="#other">別の場所</a>';
    button = document.querySelector("button")!;
    recovery = document.querySelector("div")!;
    input = document.querySelector("input")!;
    input.value = sub;
    status = document.querySelector("p")!;
    copied = vi.fn<() => void>();
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    setupConnectionCopy({ button, recovery, input, status }, copied);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });
  it("copies the exact already displayed value only on explicit click", async () => {
    expect(writeText).not.toHaveBeenCalled();
    button.click();
    await settle();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(sub);
    expect(copied).toHaveBeenCalledOnce();
    expect(recovery.hidden).toBe(true);
    expect(status.textContent).toBe("Sub ID をコピーしました。");
    expect(button.disabled).toBe(false);
  });
  for (const mode of ["denied", "unavailable"] as const) {
    it(`exposes exact readonly manual fallback when ${mode}`, async () => {
      if (mode === "denied")
        writeText.mockRejectedValue(new DOMException("Synthetic", "NotAllowedError"));
      else Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
      button.focus();
      button.click();
      await settle();
      expect(copied).not.toHaveBeenCalled();
      expect(recovery.hidden).toBe(false);
      expect(input.readOnly).toBe(true);
      expect(input.value).toBe(sub);
      expect(document.activeElement).toBe(input);
      expect(input.selectionStart).toBe(0);
      expect(input.selectionEnd).toBe(sub.length);
      expect(status.textContent).toContain("コピーできませんでした");
      expect(button.disabled).toBe(false);
      expect(button.hasAttribute("aria-busy")).toBe(false);
    });
  }
  it("does not steal newer focus after a pending failure", async () => {
    let reject!: (e: unknown) => void;
    writeText.mockReturnValue(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    button.focus();
    button.click();
    const other = document.querySelector("a")!;
    other.focus();
    reject(new Error("Synthetic"));
    await settle();
    expect(document.activeElement).toBe(other);
    expect(recovery.hidden).toBe(false);
  });
  it("blocks repeated pending dispatches and permits a later explicit retry", async () => {
    let reject!: (e: unknown) => void;
    writeText.mockReturnValueOnce(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    button.click();
    button.dispatchEvent(new MouseEvent("click"));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    reject(new Error("Synthetic"));
    await settle();
    expect(writeText).toHaveBeenCalledTimes(1);
    button.focus();
    button.click();
    await settle();
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(copied).toHaveBeenCalledOnce();
    expect(recovery.hidden).toBe(true);
  });
  it("never reads an edited fallback as a new copy payload", async () => {
    input.value = "not-the-rendered-sub";
    button.click();
    await settle();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(sub);
  });
});

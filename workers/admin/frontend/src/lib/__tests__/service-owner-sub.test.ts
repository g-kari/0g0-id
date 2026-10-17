import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { setupOwnerSub } from "../service-owner-sub";

const service = {
  id: "synthetic-id",
  client_id: "synthetic-client",
  owner_user_id: "synthetic-owner",
};
const data = {
  service_id: service.id,
  client_id: service.client_id,
  owner_user_id: service.owner_user_id,
  sub: "a".repeat(64),
};
class Element extends EventTarget {
  textContent = "";
  disabled = false;
  click(): void {
    this.dispatchEvent(new Event("click"));
  }
}
function elements(): {
  value: Element;
  status: Element;
  load: Element;
  copy: Element;
} {
  const els = {
    value: new Element(),
    status: new Element(),
    load: new Element(),
    copy: new Element(),
  };
  els.copy.disabled = true;
  setupOwnerSub(service, els as unknown as Parameters<typeof setupOwnerSub>[1]);
  return els;
}
const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};
const response = (body: unknown = data): Response =>
  new Response(JSON.stringify({ data: body }), { status: 200 });

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response()));
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("owner subject controls", () => {
  it("loads only after explicit confirmation, with no-store, and copies only after a click", async () => {
    const els = elements();
    expect(fetch).not.toHaveBeenCalled();
    expect(els.copy.disabled).toBe(true);
    els.load.click();
    await flush();
    expect(fetch).toHaveBeenCalledWith(
      "/api/services/synthetic-id/owner-sub",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(els.value.textContent).toBe(data.sub);
    expect(els.copy.disabled).toBe(false);
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    els.copy.click();
    await flush();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(data.sub);
    expect(els.status.textContent).toBe("コピーしました。");
  });
  it("does not copy before successful retrieval", async () => {
    const els = elements();
    els.copy.click();
    await flush();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });
  it("keeps failures local and allows retry", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("private-error"));
    const els = elements();
    els.load.click();
    await flush();
    expect(els.value.textContent).toBe("");
    expect(els.copy.disabled).toBe(true);
    expect(els.load.disabled).toBe(false);
    expect(els.status.textContent).toContain("取得に失敗");
    expect(els.status.textContent).not.toContain("private-error");
    els.load.click();
    await flush();
    expect(els.value.textContent).toBe(data.sub);
  });
  it.each([
    { ...data, owner_user_id: "changed-owner" },
    { ...data, client_id: "wrong-client" },
    { ...data, service_id: "wrong-service" },
    { ...data, sub: '<img src=x onerror="alert(1)">' },
    null,
  ])("rejects stale, mismatched or malformed responses", async (body) => {
    vi.mocked(fetch).mockResolvedValue(response(body));
    const els = elements();
    els.load.click();
    await flush();
    expect(els.value.textContent).toBe("");
    expect(els.copy.disabled).toBe(true);
    expect(els.status.textContent).toContain("取得に失敗");
  });
  it("clears an old value when a later request fails", async () => {
    const els = elements();
    els.load.click();
    await flush();
    expect(els.value.textContent).toBe(data.sub);
    vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));
    els.load.click();
    await flush();
    expect(els.value.textContent).toBe("");
    expect(els.copy.disabled).toBe(true);
  });
  it("blocks repeated load clicks while pending", async () => {
    let resolve!: (res: Response) => void;
    vi.mocked(fetch).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const els = elements();
    els.load.click();
    els.load.click();
    expect(fetch).toHaveBeenCalledOnce();
    expect(els.load.disabled).toBe(true);
    expect(els.copy.disabled).toBe(true);
    resolve(response());
    await flush();
    expect(els.load.disabled).toBe(false);
  });
  it("shows manual-copy guidance and permits another attempt if clipboard is denied", async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error("denied"));
    const els = elements();
    els.load.click();
    await flush();
    els.copy.click();
    await flush();
    expect(els.status.textContent).toContain("表示された値を選択");
    expect(els.value.textContent).toBe(data.sub);
    expect(els.copy.disabled).toBe(false);
    els.copy.click();
    await flush();
    expect(els.status.textContent).toBe("コピーしました。");
  });
  it("handles browsers without clipboard support", async () => {
    vi.stubGlobal("navigator", {});
    const els = elements();
    els.load.click();
    await flush();
    els.copy.click();
    await flush();
    expect(els.status.textContent).toContain("コピーできません");
    expect(els.copy.disabled).toBe(false);
  });
});

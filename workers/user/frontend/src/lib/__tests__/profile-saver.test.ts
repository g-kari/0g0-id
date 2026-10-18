// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { MyProfile } from "@0g0-id/api-types";
import { createProfileSaver, type ProfileDraft } from "../profile-saver";

const profile: MyProfile = {
  id: "synthetic",
  email: "synthetic@example.invalid",
  name: "Submitted",
  picture: null,
  phone: null,
  address: null,
  role: "user",
};
function deferred() {
  let resolve!: (value: MyProfile) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<MyProfile>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}
describe("profile save snapshot and later draft", () => {
  let inputs: Record<keyof ProfileDraft, HTMLInputElement>;
  let button: HTMLButtonElement;
  let status: HTMLElement;
  let renderSavedProfile: ReturnType<typeof vi.fn<(profile: MyProfile) => void>>;
  let showMessage: ReturnType<typeof vi.fn<(message: string, type: "success" | "error") => void>>;
  beforeEach(() => {
    const page = readFileSync(
      fileURLToPath(new NodeURL("../../pages/profile.astro", import.meta.url)),
      "utf8",
    );
    document.body.innerHTML = page.split(/<Base[^>]*>/)[1].split("</Base>")[0];
    inputs = Object.fromEntries(
      ["name", "picture", "phone", "address"].map((field) => [
        field,
        document.getElementById(field),
      ]),
    ) as typeof inputs;
    inputs.name.value = " Submitted ";
    button = document.getElementById("save-btn") as HTMLButtonElement;
    status = document.getElementById("profile-save-status")!;
    renderSavedProfile = vi.fn();
    showMessage = vi.fn();
  });
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });
  function setup(save: (draft: ProfileDraft) => Promise<MyProfile>) {
    const run = createProfileSaver({
      inputs,
      button,
      status,
      save,
      renderSavedProfile,
      showMessage,
    });
    button.addEventListener("click", () => void run());
    return run;
  }
  function edit(field: keyof ProfileDraft, value: string) {
    inputs[field].value = value;
    inputs[field].dispatchEvent(new Event("input", { bubbles: true }));
  }
  it("normalizes untouched fields from the confirmed response and announces success", async () => {
    const save = vi.fn(async () => profile);
    const run = setup(save);
    await run();
    expect(save).toHaveBeenCalledWith({ name: " Submitted ", picture: "", phone: "", address: "" });
    expect(inputs.name.value).toBe("Submitted");
    expect(renderSavedProfile).toHaveBeenCalledWith(profile);
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe("保存しました");
    expect(button.disabled).toBe(false);
  });
  it.each(["name", "picture", "phone", "address"] as const)(
    "retains newer %s while applying normalization to untouched fields",
    async (field) => {
      const pending = deferred();
      const run = setup(() => pending.promise);
      const done = run();
      edit(field, "New unsaved synthetic value");
      pending.resolve(profile);
      await done;
      expect(inputs[field].value).toBe("New unsaved synthetic value");
      if (field !== "name") expect(inputs.name.value).toBe("Submitted");
      expect(status.textContent).toContain("未保存");
      expect(showMessage).not.toHaveBeenCalledWith("保存しました", "success");
      expect(renderSavedProfile).toHaveBeenCalledWith(profile);
      expect(button.disabled).toBe(false);
    },
  );
  it("preserves all four newer values and sends them only on another explicit save", async () => {
    const pending = deferred();
    const save = vi
      .fn<(draft: ProfileDraft) => Promise<MyProfile>>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({
        ...profile,
        name: "Later",
        picture: "https://example.invalid/avatar.png",
        phone: "synthetic-phone",
        address: "synthetic-address",
      });
    const run = setup(save);
    const first = run();
    const later = {
      name: "Later",
      picture: "https://example.invalid/avatar.png",
      phone: "synthetic-phone",
      address: "synthetic-address",
    };
    for (const [field, value] of Object.entries(later)) edit(field as keyof ProfileDraft, value);
    pending.resolve(profile);
    await first;
    expect(save).toHaveBeenCalledTimes(1);
    expect(status.textContent).toContain("未保存");
    await run();
    expect(save).toHaveBeenLastCalledWith(later);
    expect(status.textContent).toBe("保存しました");
  });
  it("blocks native repeated clicks and a directly repeated invocation while pending", async () => {
    const pending = deferred();
    const save = vi.fn<(draft: ProfileDraft) => Promise<MyProfile>>(() => pending.promise);
    const run = setup(save);
    button.click();
    button.click();
    await run();
    expect(save).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    for (const input of Object.values(inputs)) {
      expect(input.disabled).toBe(false);
      expect(input.readOnly).toBe(false);
    }
    pending.resolve(profile);
    await pending.promise;
    await Promise.resolve();
    expect(button.disabled).toBe(false);
  });
  it.each([
    new Error("Synthetic save failure"),
    new Error(""),
    new Error("  "),
    { reason: "synthetic" },
  ])(
    "keeps the later draft after failure and permits a successful explicit retry",
    async (failure) => {
      const pending = deferred();
      const save = vi
        .fn<(draft: ProfileDraft) => Promise<MyProfile>>()
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValueOnce({ ...profile, name: "Later" });
      const run = setup(save);
      const first = run();
      edit("name", "Later");
      pending.reject(failure);
      await first;
      expect(inputs.name.value).toBe("Later");
      expect(renderSavedProfile).not.toHaveBeenCalled();
      expect(showMessage).toHaveBeenLastCalledWith(expect.any(String), "error");
      expect(button.disabled).toBe(false);
      await run();
      expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ name: "Later" }));
      expect(status.textContent).toBe("保存しました");
    },
  );
  it("does not call a value already equal to the confirmed normalized value unsaved", async () => {
    const pending = deferred();
    const run = setup(() => pending.promise);
    const done = run();
    edit("name", "Submitted");
    pending.resolve(profile);
    await done;
    expect(inputs.name.value).toBe("Submitted");
    expect(status.textContent).toBe("保存しました");
  });
  it("announces subsequent edits as unsaved rather than leaving the old success notice", async () => {
    const run = setup(async () => profile);
    await run();
    edit("address", "Later synthetic address");
    expect(status.textContent).toBe("編集中です。保存するには「保存」を押してください。");
  });
  it("treats submitted strings as a fixed snapshot, including empty optional values", async () => {
    const pending = deferred();
    const save = vi.fn<(draft: ProfileDraft) => Promise<MyProfile>>(() => pending.promise);
    const run = setup(save);
    const done = run();
    edit("address", "New");
    expect(save.mock.calls[0][0]).toEqual({
      name: " Submitted ",
      picture: "",
      phone: "",
      address: "",
    });
    pending.resolve(profile);
    await done;
  });
});

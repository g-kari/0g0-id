import type { MyProfile } from "@0g0-id/api-types";

type Field = "name" | "picture" | "phone" | "address";
export type ProfileDraft = Record<Field, string>;
interface Options {
  inputs: Record<Field, HTMLInputElement>;
  button: HTMLButtonElement;
  status: HTMLElement;
  save: (draft: ProfileDraft) => Promise<MyProfile>;
  renderSavedProfile: (profile: MyProfile) => void;
  showMessage: (message: string, type: "success" | "error") => void;
}
const fields: readonly Field[] = ["name", "picture", "phone", "address"];

/** Own only this page's save UI; authentication and the API contract stay with the caller. */
export function createProfileSaver(options: Options): () => Promise<void> {
  const { inputs, button, status, save, renderSavedProfile, showMessage } = options;
  let pending = false;
  for (const field of fields) {
    inputs[field].addEventListener("input", () => {
      status.textContent = pending
        ? "保存中に編集した内容は、まだ保存されていません。"
        : "編集中です。保存するには「保存」を押してください。";
    });
  }
  return async (): Promise<void> => {
    if (pending) return;
    pending = true;
    button.disabled = true;
    button.textContent = "保存中...";
    status.textContent = "保存中...";
    // Raw strings are the submitted snapshot. Do not read newer input into this request.
    const submitted: ProfileDraft = {
      name: inputs.name.value,
      picture: inputs.picture.value,
      phone: inputs.phone.value,
      address: inputs.address.value,
    };
    try {
      const updated = await save(submitted);
      renderSavedProfile(updated);
      let hasNewerDraft = false;
      for (const field of fields) {
        if (inputs[field].value === submitted[field]) {
          // Preserve server normalization only where the user has not typed a newer value.
          inputs[field].value = updated[field] ?? "";
        } else if (inputs[field].value !== (updated[field] ?? "")) {
          hasNewerDraft = true;
        }
      }
      const message = hasNewerDraft
        ? "送信した内容を保存しました。保存中に編集した内容は未保存です。もう一度「保存」で保存してください。"
        : "保存しました";
      status.textContent = message;
      showMessage(message, "success");
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim() ? error.message : "保存に失敗しました";
      status.textContent = message;
      showMessage(message, "error");
    } finally {
      pending = false;
      button.disabled = false;
      button.textContent = "保存";
    }
  };
}

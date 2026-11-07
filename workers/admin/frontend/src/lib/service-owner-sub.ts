import type { ServiceOwnerSub, ServiceSummary } from "@0g0-id/api-types";
import { apiFetch } from "./api";

type OwnerSubElements = {
  value: HTMLElement;
  status: HTMLElement;
  load: HTMLButtonElement;
  copy: HTMLButtonElement;
};

export function setupOwnerSub(
  service: Pick<ServiceSummary, "id" | "client_id" | "owner_user_id">,
  elements: OwnerSubElements,
): void {
  let sub: string | null = null;
  let loading = false;
  let copying = false;

  elements.load.addEventListener("click", async (): Promise<void> => {
    if (loading || copying) return;
    loading = true;
    sub = null;
    elements.value.textContent = "";
    elements.load.disabled = true;
    elements.copy.disabled = true;
    elements.status.textContent = "取得中…";
    try {
      const result = await apiFetch<ServiceOwnerSub>(
        `/api/services/${encodeURIComponent(service.id)}/owner-sub`,
        { cache: "no-store" },
      );
      if (
        !result ||
        result.service_id !== service.id ||
        result.client_id !== service.client_id ||
        result.owner_user_id !== service.owner_user_id ||
        !/^[a-f0-9]{64}$/.test(result.sub)
      ) {
        throw new Error("Invalid owner subject response");
      }
      sub = result.sub;
      elements.value.textContent = sub;
      elements.status.textContent = "取得しました。外部サービスのオーナー設定に使用できます。";
      elements.copy.disabled = false;
    } catch {
      elements.status.textContent =
        "取得に失敗しました。所有者が変更された場合はページを再読み込みしてください。";
    } finally {
      loading = false;
      elements.load.disabled = false;
    }
  });

  elements.copy.addEventListener("click", async (): Promise<void> => {
    if (!sub || loading || copying) return;
    copying = true;
    elements.copy.disabled = true;
    elements.load.disabled = true;
    try {
      await navigator.clipboard.writeText(sub);
      elements.status.textContent = "コピーしました。";
    } catch {
      elements.status.textContent =
        "コピーできませんでした。表示された値を選択してコピーしてください。";
    } finally {
      copying = false;
      elements.copy.disabled = false;
      elements.load.disabled = false;
    }
  });
}

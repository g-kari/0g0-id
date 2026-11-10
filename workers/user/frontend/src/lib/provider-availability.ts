import { isProviderAvailable } from "../../../src/lib/provider-availability";
export { isProviderAvailable };

export function applyProviderAvailability(configured: unknown): void {
  for (const element of document.querySelectorAll<HTMLElement>("[data-provider]")) {
    const available = isProviderAvailable(element.dataset.provider ?? "", configured);
    element.hidden = !available;
    element.style.display = available ? "" : "none";
  }
}

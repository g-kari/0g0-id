/** New login methods are opt-in, including when discovery fails or is incomplete. */
export function isProviderAvailable(provider: string, configured: unknown): boolean {
  const value =
    configured && typeof configured === "object" && !Array.isArray(configured)
      ? (configured as Record<string, unknown>)[provider]
      : undefined;
  return provider === "discord" || provider === "steam" ? value === true : value !== false;
}

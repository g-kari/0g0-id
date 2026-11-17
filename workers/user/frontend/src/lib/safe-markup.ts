import { formatDatetime } from "./api";
import { escapeHtml, getInitials } from "./helpers";

export type ProfileAvatarUser = {
  name: string | null;
  email: string;
  picture: string | null;
};

export type LinkedSessionRow = {
  id: string;
  service_name: string | null;
  created_at: string;
  expires_at: string;
};

export type ProviderListStatus = {
  provider: string;
  connected: boolean;
};

export function renderProfileAvatarHtml(user: ProfileAvatarUser): string {
  if (user.picture) {
    return `<img src="${escapeHtml(user.picture)}" alt="アバター" style="width:64px; height:64px; border-radius:50%; object-fit:cover;" />`;
  }
  return `<div style="width:64px; height:64px; border-radius:50%; background:var(--color-accent); color:white; display:flex; align-items:center; justify-content:center; font-size:1.5rem; font-weight:700;">${escapeHtml(getInitials(user.name, user.email))}</div>`;
}

/** デバイス認可でクライアントが要求したスコープ。クライアント入力なので HTML にしない。 */
export function renderDeviceScopeBadges(scopes: readonly string[]): string {
  return scopes
    .map(
      (scope) =>
        `<span class="text-xs font-medium px-2.5 py-1 rounded-full" style="background: rgba(115,134,45,0.1); color: var(--color-accent)">${escapeHtml(scope)}</span>`,
    )
    .join("");
}

export function renderLinkedSessionRows(sessions: readonly LinkedSessionRow[]): string {
  return sessions
    .map(
      (session) => `
      <div class="flex items-center justify-between py-3.5 border-b last:border-b-0" style="border-color: var(--color-border)">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-1.5 font-semibold text-sm">
            ${
              session.service_name
                ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/></svg>${escapeHtml(session.service_name)}`
                : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>0g0 ID（IdP セッション）`
            }
          </div>
          <div class="text-xs mt-0.5" style="color: var(--color-muted)">
            作成: ${escapeHtml(formatDatetime(session.created_at))} ／ 有効期限: ${escapeHtml(formatDatetime(session.expires_at))}
          </div>
        </div>
        <button class="btn btn-danger btn-sm ml-3" data-revoke="${escapeHtml(session.id)}">無効化</button>
      </div>
    `,
    )
    .join("");
}

export function renderProviderListHtml<P extends string>(
  statuses: readonly { provider: P; connected: boolean }[],
  options: {
    labels: Readonly<Partial<Record<P, string>>>;
    icons: Readonly<Partial<Record<P, string>>>;
    isConfigured: (provider: P) => boolean;
    linkedCount: number;
  },
): string {
  return statuses
    .map((status, index) => {
      const borderStyle = index > 0 ? "border-top:1px solid var(--color-border);" : "";
      const configured = options.isConfigured(status.provider);
      const provider = escapeHtml(status.provider);
      const knownLabel = options.labels[status.provider];
      const label = knownLabel === undefined ? provider : escapeHtml(knownLabel);
      const icon = options.icons[status.provider] ?? "";
      const actionHtml = status.connected
        ? `<button class="btn btn-ghost btn-sm" data-unlink="${provider}" ${options.linkedCount <= 1 ? 'disabled title="最後の連携プロバイダーは解除できません"' : ""}>連携解除</button>`
        : configured
          ? `<form method="post" action="/auth/link"><input type="hidden" name="provider" value="${provider}" /><button type="submit" class="btn btn-primary btn-sm">連携する</button></form>`
          : ``;
      const statusLabel = status.connected
        ? "連携済み"
        : configured
          ? "未連携"
          : "現在利用できません";
      return `
        <div style="display:flex; align-items:center; justify-content:space-between; padding:1rem 1.5rem; ${borderStyle}">
          <div style="display:flex; align-items:center; gap:0.75rem;">
            ${icon}
            <div>
              <div style="font-weight:500; font-size:0.9375rem;">${label}</div>
              <div style="font-size:0.75rem; color:var(--color-muted); margin-top:2px;">${statusLabel}</div>
            </div>
          </div>
          ${actionHtml}
        </div>`;
    })
    .join("");
}

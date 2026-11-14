import { formatDate, formatDatetime } from "./api";
import { escapeHtml } from "./helpers";

export type AdminUserListRow = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  status: "active" | "banned";
  created_at: string;
};

export type ServiceListRow = {
  id: string;
  name: string;
  client_id: string;
  created_at: string;
};

export type RedirectUriRow = {
  id: string;
  uri: string;
};

export type AuthorizedUserRow = {
  id: string;
  email: string;
  name: string;
  picture: string | null;
};

export type SessionRow = {
  id: string;
  service_name: string | null;
  created_at: string;
  expires_at: string;
};

function hrefPath(prefix: string, id: string): string {
  return `${prefix}/${escapeHtml(encodeURIComponent(id))}`;
}

/** 管理ユーザー一覧。名前・メール・ID は保存値なので HTML として解釈しない。 */
export function renderAdminUserRows(users: readonly AdminUserListRow[]): string {
  return users
    .map(
      (user) => `
        <tr>
          <td>${escapeHtml(user.name ?? "—")}</td>
          <td style="color:var(--color-muted); font-size:0.75rem; font-family:monospace; max-width:120px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(user.id)}">${escapeHtml(user.id.slice(0, 8))}…</td>
          <td style="color:var(--color-muted); font-size:0.875rem;">${escapeHtml(user.email)}</td>
          <td><span class="badge badge-${escapeHtml(user.role)}">${user.role === "admin" ? "管理者" : "ユーザー"}</span></td>
          <td><span class="badge badge-${escapeHtml(user.status)}">${user.status === "active" ? "アクティブ" : "BAN"}</span></td>
          <td style="color:var(--color-muted); font-size:0.875rem;">${escapeHtml(formatDate(user.created_at))}</td>
          <td><a href="${hrefPath("/users", user.id)}" class="btn btn-ghost" style="padding:4px 10px; font-size:0.8rem;">詳細</a></td>
        </tr>
      `,
    )
    .join("");
}

/** サービス一覧。サービス名と client id は登録値なので HTML として解釈しない。 */
export function renderAdminServiceRows(services: readonly ServiceListRow[]): string {
  return services
    .map(
      (service) => `
      <tr>
        <td style="font-weight:500;">${escapeHtml(service.name)}</td>
        <td><code style="font-size:0.8rem; background:var(--color-surface); padding:2px 6px; border-radius:4px;">${escapeHtml(service.client_id)}</code></td>
        <td style="color:var(--color-muted); font-size:0.875rem;">${escapeHtml(formatDate(service.created_at))}</td>
        <td style="display:flex; gap:6px;">
          <a href="${hrefPath("/services", service.id)}" class="btn btn-ghost" style="padding:4px 10px; font-size:0.8rem;">詳細</a>
          <button class="btn btn-danger btn-delete" style="padding:4px 10px; font-size:0.8rem;" data-id="${escapeHtml(service.id)}" data-name="${escapeHtml(service.name)}">削除</button>
        </td>
      </tr>
    `,
    )
    .join("");
}

export function renderDefinitionRows(rows: readonly (readonly string[])[]): string {
  return rows
    .map(
      ([label = "", value = ""]) => `
      <tr>
        <td style="color:var(--color-muted); padding:4px 8px 4px 0; white-space:nowrap;">${escapeHtml(label)}</td>
        <td style="padding:4px 0; word-break:break-all;">${escapeHtml(value)}</td>
      </tr>
    `,
    )
    .join("");
}

export function renderUserBadges(role: string, isBanned: boolean): string {
  return `
      <span class="badge badge-${escapeHtml(role)}">${role === "admin" ? "管理者" : "ユーザー"}</span>
      ${isBanned ? '<span class="badge badge-banned">BAN</span>' : '<span class="badge badge-active">アクティブ</span>'}
    `;
}

export function renderRedirectUriItems(uris: readonly RedirectUriRow[]): string {
  return uris
    .map(
      (uri) => `
        <div style="display:flex; align-items:center; justify-content:space-between; padding:6px 0; border-bottom:1px solid var(--color-border);">
          <code style="font-size:0.8rem; word-break:break-all;">${escapeHtml(uri.uri)}</code>
          <button class="btn btn-ghost btn-delete-uri" data-id="${escapeHtml(uri.id)}" style="font-size:0.75rem; padding:2px 8px; color:var(--color-danger);">削除</button>
        </div>
      `,
    )
    .join("");
}

export function renderAuthorizedUsers(users: readonly AuthorizedUserRow[]): string {
  return users
    .map((user) => {
      const initial = (user.name || user.email)[0]?.toUpperCase() || "?";
      const avatar = user.picture
        ? `<img src="${escapeHtml(user.picture)}" style="width:100%;height:100%;object-fit:cover;" alt="">`
        : escapeHtml(initial);
      return `
        <div style="display:flex; align-items:center; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--color-border);">
          <div style="display:flex; align-items:center; gap:8px;">
            <div style="width:32px; height:32px; border-radius:50%; background:var(--color-surface); display:flex; align-items:center; justify-content:center; font-size:0.875rem; overflow:hidden;">
              ${avatar}
            </div>
            <div>
              <div style="font-size:0.875rem;">${escapeHtml(user.name || "(名前未設定)")}</div>
              <div style="font-size:0.75rem; color:var(--color-muted);">${escapeHtml(user.email)}</div>
            </div>
          </div>
          <button class="btn btn-ghost btn-revoke-user" data-id="${escapeHtml(user.id)}" style="font-size:0.75rem; padding:2px 8px; color:var(--color-danger);">アクセス失効</button>
        </div>
      `;
    })
    .join("");
}

export function renderAdminUserSessions(sessions: readonly SessionRow[]): string {
  return sessions
    .map(
      (session) => `
        <div style="display:flex; align-items:center; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--color-border);">
          <div>
            <div style="font-size:0.875rem;">${session.service_name ? escapeHtml(session.service_name) : "BFFセッション"}</div>
            <div style="font-size:0.75rem; color:var(--color-muted);">作成: ${escapeHtml(formatDatetime(session.created_at))} / 有効期限: ${escapeHtml(formatDatetime(session.expires_at))}</div>
          </div>
          <button class="btn btn-ghost revoke-session-btn" data-id="${escapeHtml(session.id)}" style="font-size:0.75rem; padding:2px 8px;">無効化</button>
        </div>
      `,
    )
    .join("");
}

/** SVG の title / 軸ラベル。日付文字列は API 由来なのでテキストとして入れる。 */
export function renderTrendPointText(
  date: string,
  count: number,
): { title: string; label: string } {
  const safeCount = Number.isFinite(count) ? String(count) : "0";
  return {
    title: `${escapeHtml(date)}: ${safeCount}`,
    label: escapeHtml(date.slice(5)),
  };
}

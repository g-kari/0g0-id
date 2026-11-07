/**
 * Unconnected Cloudflare Email Sending adapter. No route, binding or sender is
 * enabled by this module. SendEmail is supplied by the Workers runtime types.
 */
export interface VerificationEmailInput {
  recipient: string;
  /** Opaque, random, single-purpose proof token. Not an access/session token. */
  token: string;
  /** Unix seconds, matching the email intent's server-side expiry. */
  expiresAt: number;
}

export interface VerificationEmailConfig {
  enabled: boolean;
  binding?: SendEmail;
  /** Fixed server configuration, never a submitted From address. */
  sender?: string;
  idpOrigin: string;
}

export type VerificationEmailOutcome =
  | { outcome: "disabled" | "not_configured" | "invalid_input" | "uncertain" }
  | { outcome: "accepted"; messageId: string }
  | { outcome: "rejected"; code: string };

type EmailBuilder = Parameters<SendEmail["send"]>[0];
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const DELIVERY_TIMEOUT_MS = 10_000;

// Deliberately one ASCII mailbox, not a display name, list, SMTP command or
// quoted local part. International addresses need a separate reviewed policy.
function isSingleMailbox(address: string): boolean {
  const parts = address.split("@");
  if (parts.length !== 2 || address.length > 254) return false;
  const [local, domain] = parts;
  if (
    !local ||
    local.length > 64 ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
  ) {
    return false;
  }
  const labels = domain.split(".");
  return (
    labels.length >= 2 &&
    !/^[\d.]+$/.test(domain) &&
    labels.every(
      (label) => label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
    )
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const escaped: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return escaped[char];
  });
}

/** Build a fixed-purpose message without accepting arbitrary subject/body/URL. */
export function buildVerificationEmail(
  config: Pick<VerificationEmailConfig, "sender" | "idpOrigin">,
  input: VerificationEmailInput,
): EmailBuilder {
  if (
    !config.sender ||
    !isSingleMailbox(config.sender) ||
    !isSingleMailbox(input.recipient) ||
    !TOKEN_RE.test(input.token)
  ) {
    throw new Error("Invalid email verification input");
  }
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(input.expiresAt) || input.expiresAt <= now || input.expiresAt > now + 900) {
    throw new Error("Invalid email verification expiry");
  }
  const origin = new URL(config.idpOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    !isSingleMailbox(`noreply@${origin.hostname}`)
  ) {
    throw new Error("Invalid email verification origin");
  }
  const url = new URL("/auth/email/verify", origin.origin);
  // Fragments do not travel in HTTP access logs or Referer headers. The future
  // verification page must remove the fragment before loading any other assets.
  url.hash = `token=${input.token}`;
  const link = url.toString();
  const expiry = new Date(input.expiresAt * 1000).toISOString();
  const warning = "この操作だけで登録・ログイン・パスキー追加は完了しません。";
  const ignore = "心当たりがない場合は、このメールを無視してください。";
  return {
    from: config.sender,
    to: input.recipient,
    subject: "0g0-id: メールアドレスの確認",
    text: `0g0-id のメールアドレス確認を続けるには、次のリンクを開いてください。\n\n${link}\n\n有効期限: ${expiry}\n${warning}\n${ignore}`,
    html: `<p>0g0-id のメールアドレス確認を続けてください。</p><p><a href="${escapeHtml(link)}">メールアドレスの確認を続ける</a></p><p>有効期限: ${escapeHtml(expiry)}</p><p>${warning}</p><p>${ignore}</p>`,
  };
}

const DEFINITE_REJECTIONS = new Set([
  "E_VALIDATION_ERROR",
  "E_FIELD_MISSING",
  "E_SENDER_NOT_VERIFIED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE",
  "E_RECIPIENT_NOT_ALLOWED",
  "E_RECIPIENT_SUPPRESSED",
  "E_ACCOUNT_SUSPENDED",
  "E_RATE_LIMIT_EXCEEDED",
  "E_DAILY_LIMIT_EXCEEDED",
]);

/**
 * Exactly one send attempt. Accepted means provider acceptance, not inbox
 * delivery. A timeout cannot cancel the provider operation; never auto-retry an
 * uncertain result. Keep outcomes internal so they cannot enumerate accounts.
 * No recipient, token, payload or raw provider exception is logged or returned.
 */
export async function sendVerificationEmail(
  config: VerificationEmailConfig,
  input: VerificationEmailInput,
): Promise<VerificationEmailOutcome> {
  if (config.enabled !== true) return { outcome: "disabled" };
  if (!config.binding || !config.sender) return { outcome: "not_configured" };
  let message: EmailBuilder;
  try {
    message = buildVerificationEmail(config, input);
  } catch {
    return { outcome: "invalid_input" };
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      config.binding.send(message),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), DELIVERY_TIMEOUT_MS);
      }),
    ]);
    return result && typeof result.messageId === "string" && result.messageId.length > 0
      ? { outcome: "accepted", messageId: result.messageId }
      : { outcome: "uncertain" };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : null;
    return typeof code === "string" && DEFINITE_REJECTIONS.has(code)
      ? { outcome: "rejected", code }
      : { outcome: "uncertain" };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

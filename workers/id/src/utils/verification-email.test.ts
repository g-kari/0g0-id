import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  VERIFICATION_EMAIL_SENDER,
  buildVerificationEmail,
  sendVerificationEmail,
  type VerificationEmailConfig,
} from "./verification-email";

const config = {
  enabled: true,
  sender: VERIFICATION_EMAIL_SENDER,
  idpOrigin: "https://id.example.test",
};
const input = {
  recipient: "recipient@example.test",
  token: "A".repeat(43),
  expiresAt: 1794082200,
};

function configured(send = vi.fn().mockResolvedValue({ messageId: "test-message-id" })) {
  return { ...config, binding: { send } as SendEmail };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date((input.expiresAt - 600) * 1000));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("buildVerificationEmail", () => {
  it("builds one fixed-purpose text and HTML message without arbitrary headers or redirects", () => {
    const message = buildVerificationEmail(config, input);
    expect(message.from).toBe(config.sender);
    expect(message.to).toBe(input.recipient);
    expect(message.subject).toBe("0g0-id: メールアドレスの確認");
    expect(Object.keys(message).sort()).toEqual(["from", "html", "subject", "text", "to"]);
    expect(message.text).toContain("この操作だけで登録・ログイン・パスキー追加は完了しません。");
    expect(message.html).not.toContain(input.recipient);
    const link = message.text!.match(/https:\/\/[^\s]+/)![0];
    const url = new URL(link);
    expect(url.origin).toBe(config.idpOrigin);
    expect(url.pathname).toBe("/auth/email/verify");
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#token=${input.token}`);
    expect(message.html).toContain(`href="${link}"`);
  });

  it("rejects a different configured sender even when its mailbox is valid", () => {
    expect(() =>
      buildVerificationEmail({ ...config, sender: "other@example.test" }, input),
    ).toThrow();
  });

  it.each([
    "a@example.test,b@example.test",
    "name <a@example.test>",
    "a@example.test\r\nBcc: b@example.test",
    "a@example.test\n",
    " a@example.test",
    "a@example.test ",
    "a@localhost",
    "a@127.0.0.1",
    "a@-example.test",
    "a@example..test",
    ".a@example.test",
    "a.@example.test",
    "a..b@example.test",
    '"a"@example.test',
    "日本語@example.test",
    `${"a".repeat(65)}@example.test`,
    `a@${"a".repeat(64)}.test`,
  ])("rejects a list, malformed or unsupported mailbox: %s", (recipient) => {
    expect(() => buildVerificationEmail(config, { ...input, recipient })).toThrow();
    expect(() => buildVerificationEmail({ ...config, sender: recipient }, input)).toThrow();
  });

  it.each(["", "short", "A".repeat(42), "A".repeat(44), "!".repeat(43), "\n".repeat(43)])(
    "rejects a malformed token",
    (token) => {
      expect(() => buildVerificationEmail(config, { ...input, token })).toThrow();
    },
  );

  it.each([-1, 0, 900.5, NaN, Infinity, 901])("rejects an invalid expiry offset %s", (offset) => {
    expect(() =>
      buildVerificationEmail(config, { ...input, expiresAt: Date.now() / 1000 + offset }),
    ).toThrow();
  });

  it("accepts the exact 15 minute expiry boundary", () => {
    expect(() =>
      buildVerificationEmail(config, { ...input, expiresAt: Date.now() / 1000 + 900 }),
    ).not.toThrow();
  });

  it.each([
    "http://id.example.test",
    "https://user:secret@id.example.test",
    "https://id.example.test/path",
    "https://id.example.test?redirect=evil",
    "https://id.example.test#fragment",
    "https://*.example.test",
    "https://localhost",
    "https://127.0.0.1",
    "not-a-url",
  ])("rejects an unsafe configured origin: %s", (idpOrigin) => {
    expect(() => buildVerificationEmail({ ...config, idpOrigin }, input)).toThrow();
  });
});

describe("sendVerificationEmail", () => {
  it.each([false, undefined, null, 0, 1, "", "false", {}, []])(
    "is disabled unless enabled is the boolean true: %j",
    async (enabled) => {
      const env = configured();
      expect(await sendVerificationEmail({ ...env, enabled: enabled as boolean }, input)).toEqual({
        outcome: "disabled",
      });
      expect(env.binding.send).not.toHaveBeenCalled();
    },
  );

  it("fails closed without an approved sender or binding", async () => {
    for (const env of [{ ...config }, { ...configured(), sender: undefined }]) {
      expect(await sendVerificationEmail(env, input)).toEqual({ outcome: "not_configured" });
    }
  });

  it("does not call the provider with invalid input", async () => {
    const env = configured();
    expect(await sendVerificationEmail(env, { ...input, recipient: "invalid" })).toEqual({
      outcome: "invalid_input",
    });
    expect(env.binding.send).not.toHaveBeenCalled();
  });

  it("sends exactly once and reports provider acceptance, not email ownership", async () => {
    const env = configured();
    expect(await sendVerificationEmail(env, input)).toEqual({
      outcome: "accepted",
      messageId: "test-message-id",
    });
    expect(env.binding.send).toHaveBeenCalledExactlyOnceWith(buildVerificationEmail(config, input));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    "E_VALIDATION_ERROR",
    "E_FIELD_MISSING",
    "E_SENDER_NOT_VERIFIED",
    "E_SENDER_DOMAIN_NOT_AVAILABLE",
    "E_RECIPIENT_NOT_ALLOWED",
    "E_RECIPIENT_SUPPRESSED",
    "E_ACCOUNT_SUSPENDED",
    "E_RATE_LIMIT_EXCEEDED",
    "E_DAILY_LIMIT_EXCEEDED",
  ])("reports a documented rejection without forwarding provider text: %s", async (code) => {
    const send = vi.fn().mockRejectedValue(Object.assign(new Error(input.token), { code }));
    expect(await sendVerificationEmail(configured(send), input)).toEqual({
      outcome: "rejected",
      code,
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it.each([
    new Error("provider exception includes private payload"),
    Object.assign(new Error("temporary service error"), { code: "E_INTERNAL_SERVER_ERROR" }),
    Object.assign(new Error("SMTP result unknown"), { code: "E_DELIVERY_FAILED" }),
    "unexpected rejection",
  ])("treats ambiguous errors as uncertain, without retrying or logging", async (error) => {
    const log = vi.spyOn(console, "log");
    const warn = vi.spyOn(console, "warn");
    const errorLog = vi.spyOn(console, "error");
    const send = vi.fn().mockRejectedValue(error);
    expect(await sendVerificationEmail(configured(send), input)).toEqual({ outcome: "uncertain" });
    expect(send).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("times out without claiming cancellation or retrying a possibly accepted email", async () => {
    let accept: (value: EmailSendResult) => void = () => {};
    const send = vi.fn().mockImplementation(
      () =>
        new Promise<EmailSendResult>((resolve) => {
          accept = resolve;
        }),
    );
    const result = sendVerificationEmail(configured(send), input);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toEqual({ outcome: "uncertain" });
    accept({ messageId: "late-acceptance" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenCalledOnce();
    expect(await result).toEqual({ outcome: "uncertain" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry or expose a provider rejection after the timeout", async () => {
    let reject: (reason: Error) => void = () => {};
    const send = vi.fn().mockImplementation(
      () =>
        new Promise<EmailSendResult>((_resolve, rejectPromise) => {
          reject = rejectPromise;
        }),
    );
    const result = sendVerificationEmail(configured(send), input);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toEqual({ outcome: "uncertain" });
    reject(Object.assign(new Error(input.token), { code: "E_RATE_LIMIT_EXCEEDED" }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toEqual({ outcome: "uncertain" });
    expect(send).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("contains a synchronous send exception without logging or retrying", async () => {
    const send = vi.fn().mockImplementation(() => {
      throw new Error(input.token);
    });
    expect(await sendVerificationEmail(configured(send), input)).toEqual({ outcome: "uncertain" });
    expect(send).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not infer acceptance from a malformed provider result", async () => {
    const env: VerificationEmailConfig = configured(vi.fn().mockResolvedValue({}));
    expect(await sendVerificationEmail(env, input)).toEqual({ outcome: "uncertain" });
  });
});

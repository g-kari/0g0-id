/**
 * 構造化ロガーユーティリティ
 *
 * Cloudflare Workers のコンソールログを構造化JSON形式で出力する。
 * createLogger(context) でコンテキスト付きロガーを生成する。
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  level: LogLevel;
  ctx: string;
  msg: string;
  err?: string;
  stack?: string;
  data?: unknown;
}

type LoggerFn = (msg: string, extra?: unknown) => void;

export interface Logger {
  debug: LoggerFn;
  info: LoggerFn;
  warn: LoggerFn;
  error: LoggerFn;
}

/**
 * コンテキスト付き構造化ロガーを生成する。
 *
 * @param context ログのコンテキスト識別子（例: 'id', 'token-introspect', 'oauth-google'）
 * @returns Logger インスタンス
 */
export function createLogger(context: string): Logger {
  function log(level: LogLevel, msg: string, extra?: unknown): void {
    const entry: LogEntry = { level, ctx: context, msg };
    if (extra !== undefined) {
      if (extra instanceof Error) {
        entry.err = extra.message;
        if (extra.stack) entry.stack = extra.stack;
      } else {
        entry.data = extra;
      }
    }
    const line = JSON.stringify(entry);
    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  return {
    debug: (msg, extra) => log("debug", msg, extra),
    info: (msg, extra) => log("info", msg, extra),
    warn: (msg, extra) => log("warn", msg, extra),
    error: (msg, extra) => log("error", msg, extra),
  };
}

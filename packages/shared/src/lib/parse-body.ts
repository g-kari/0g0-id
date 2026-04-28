import type { Context, Env } from "hono";
import type { z } from "zod";
import { validationErrorBody } from "./errors";

/**
 * リクエストボディのJSONパースとZodバリデーションを一括で行うユーティリティ。
 * 成功時は `{ ok: true, data }` を、失敗時は `{ ok: false, response }` を返す。
 *
 * @example
 * const result = await parseJsonBody(c, MySchema);
 * if (!result.ok) return result.response;
 * const body = result.data;
 */
export async function parseJsonBody<T, E extends Env = Env>(
  c: Context<E>,
  schema: z.ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return {
      ok: false,
      response: c.json({ error: { code: "BAD_REQUEST", message: "Invalid JSON body" } }, 400),
    };
  }

  const parsed = schema.safeParse(rawBody);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => ({
      path: issue.path.map(String),
      message: issue.message,
    }));
    return {
      ok: false,
      response: c.json(
        validationErrorBody(parsed.error.issues[0]?.message ?? "Invalid request", details),
        400,
      ),
    };
  }

  return { ok: true, data: parsed.data };
}

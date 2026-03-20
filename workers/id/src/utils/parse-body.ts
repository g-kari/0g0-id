import type { Context } from 'hono';
import type { z } from 'zod';

/**
 * リクエストボディのJSONパースとZodバリデーションを一括で行うユーティリティ。
 * 成功時は `{ ok: true, data }` を、失敗時は `{ ok: false, response }` を返す。
 *
 * @example
 * const result = await parseJsonBody(c, MySchema);
 * if (!result.ok) return result.response;
 * const body = result.data;
 */
export async function parseJsonBody<T>(
  c: Context,
  schema: z.ZodType<T>
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return {
      ok: false,
      response: c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } }, 400),
    };
  }

  const parsed = schema.safeParse(rawBody);
  if (!parsed.success) {
    return {
      ok: false,
      response: c.json(
        { error: { code: 'BAD_REQUEST', message: parsed.error.issues[0]?.message ?? 'Invalid request' } },
        400
      ),
    };
  }

  return { ok: true, data: parsed.data };
}

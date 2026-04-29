import type { HonoRequest } from "hono";

/**
 * Content-Type に応じてリクエストボディをパースし、Record<string, unknown> として返す。
 * application/x-www-form-urlencoded の場合は parseBody、それ以外は JSON としてパースする（後方互換）。
 * パース失敗時は null を返す。
 */
export async function parseRequestBody(req: HonoRequest): Promise<Record<string, unknown> | null> {
  const contentType = req.header("Content-Type") ?? "";
  try {
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const body = await req.parseBody();
      return body as Record<string, unknown>;
    }
    return await req.json<Record<string, unknown>>();
  } catch {
    return null;
  }
}

/**
 * リクエストボディから client_id を抽出する。取得できない場合は null を返す。
 * rate-limit middleware 等で利用。
 */
export async function extractClientIdFromBody(req: HonoRequest): Promise<string | null> {
  const body = await parseRequestBody(req);
  if (!body) return null;
  return typeof body["client_id"] === "string" ? body["client_id"] : null;
}

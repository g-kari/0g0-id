import type { Context } from "hono";
import { z } from "zod";
import type { IdpEnv } from "@0g0-id/shared";
import {
  parseJsonBody,
  bindDeviceKeyToBffSession,
  findActiveBffSession,
  createLogger,
} from "@0g0-id/shared";

const dbscLogger = createLogger("dbsc-bind");

// 公開 JWK の最小スキーマ（ES256 / P-256 のみ）。
const PublicJwkSchema = z
  .object({
    kty: z.literal("EC"),
    crv: z.literal("P-256"),
    x: z.string().min(1),
    y: z.string().min(1),
  })
  .strict();

const BindDeviceSchema = z.object({
  session_id: z.string().min(1).max(128),
  public_jwk: PublicJwkSchema,
});

/**
 * POST /auth/dbsc/bind — DBSC 端末公開鍵を bff_sessions に結びつける（BFF Worker 専用 internal API）。
 *
 * - serviceBindingMiddleware で保護される（X-Internal-Secret 必須）。
 * - Phase 1 ではバインド記録のみ。チャレンジ・リフレッシュは Phase 2 で対応。
 * - 二重バインド（既に device_public_key_jwk を持つセッション）は拒否する。
 */
export async function handleDbscBind(c: Context<{ Bindings: IdpEnv }>) {
  const result = await parseJsonBody(c, BindDeviceSchema);
  if (!result.ok) return result.response;
  const body = result.data;

  // 失効済み・期限切れ・存在しないセッションは弾く
  const session = await findActiveBffSession(c.env.DB, body.session_id);
  if (!session) {
    return c.json(
      { error: { code: "INVALID_SESSION", message: "Session not found or expired" } },
      404,
    );
  }

  // 呼び出し元 BFF とセッション発行 BFF の一致確認（X-Internal-Secret 漏洩時の被害局所化）。
  // 例: admin BFF から user BFF のセッションをバインドさせない。
  const callerOrigin = c.req.header("X-BFF-Origin");
  if (!callerOrigin || callerOrigin !== session.bff_origin) {
    return c.json({ error: { code: "FORBIDDEN", message: "Caller mismatch" } }, 403);
  }

  // 二重バインド・期限切れ・失効は bindDeviceKeyToBffSession 内の WHERE 句で
  // アトミックに排除されるため、事前 SELECT による分岐は冗長。changes=0 を
  // ALREADY_BOUND として一本化する。
  let bound: boolean;
  try {
    bound = await bindDeviceKeyToBffSession(
      c.env.DB,
      body.session_id,
      JSON.stringify(body.public_jwk),
    );
  } catch (err) {
    dbscLogger.error("[dbsc-bind] DB update failed", err);
    return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
  }

  if (!bound) {
    return c.json(
      { error: { code: "ALREADY_BOUND", message: "Session is already device-bound" } },
      409,
    );
  }

  return c.json({ data: { session_id: body.session_id, bound_at: Math.floor(Date.now() / 1000) } });
}

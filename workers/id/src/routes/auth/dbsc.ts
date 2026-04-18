import type { Context } from "hono";
import { z } from "zod";
import type { IdpEnv } from "@0g0-id/shared";
import {
  parseJsonBody,
  bindDeviceKeyToBffSession,
  findActiveBffSession,
  createLogger,
  generateToken,
  issueDbscChallenge,
  consumeDbscChallenge,
  parseStoredDbscPublicJwk,
  verifyDbscProofJwt,
} from "@0g0-id/shared";

const dbscLogger = createLogger("dbsc-bind");
const dbscChallengeLogger = createLogger("dbsc-challenge");
const dbscVerifyLogger = createLogger("dbsc-verify");

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

const ChallengeSchema = z.object({
  session_id: z.string().min(1).max(128),
});

const VerifySchema = z.object({
  session_id: z.string().min(1).max(128),
  jwt: z.string().min(1).max(8192),
});

/**
 * 呼び出し元 BFF とセッション発行 BFF の一致確認。
 * X-Internal-Secret 漏洩時の被害局所化のため、例えば admin BFF から
 * user BFF のセッションに対する DBSC 操作は拒否する。
 */
function checkCallerOrigin(
  c: Context<{ Bindings: IdpEnv }>,
  sessionOrigin: string,
): Response | null {
  const callerOrigin = c.req.header("X-BFF-Origin");
  if (!callerOrigin || callerOrigin !== sessionOrigin) {
    return c.json({ error: { code: "FORBIDDEN", message: "Caller mismatch" } }, 403);
  }
  return null;
}

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

  const originErr = checkCallerOrigin(c, session.bff_origin);
  if (originErr) return originErr;

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

/**
 * POST /auth/dbsc/challenge — refresh 用の nonce を発行する（BFF Worker 専用 internal API）。
 *
 * - 端末バインド済み（device_public_key_jwk IS NOT NULL）のセッションに対してのみ発行する。
 * - TTL は 60 秒。nonce は十分長い乱数（base64url 32byte）。
 * - リプレイ対策は dbsc_challenges.consume_at による一回限り消費で担保する。
 * - 列挙攻撃ヒント（未バインド／期限切れ／存在しない の差）は外向きに区別しない。
 */
export async function handleDbscChallenge(c: Context<{ Bindings: IdpEnv }>) {
  const result = await parseJsonBody(c, ChallengeSchema);
  if (!result.ok) return result.response;
  const body = result.data;

  const session = await findActiveBffSession(c.env.DB, body.session_id);
  if (!session || !session.device_public_key_jwk) {
    return c.json(
      { error: { code: "INVALID_SESSION", message: "Session not found or not device-bound" } },
      404,
    );
  }

  const originErr = checkCallerOrigin(c, session.bff_origin);
  if (originErr) return originErr;

  const nonce = generateToken(32);
  try {
    const issued = await issueDbscChallenge(c.env.DB, {
      nonce,
      sessionId: body.session_id,
      ttlSeconds: 60,
    });
    return c.json({ data: { nonce: issued.nonce, expires_at: issued.expires_at } });
  } catch (err) {
    dbscChallengeLogger.error("[dbsc-challenge] DB insert failed", err);
    return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
  }
}

/**
 * POST /auth/dbsc/verify — Chrome が返した proof JWT を検証し、nonce を消費する。
 *
 * - 端末公開鍵で ES256 署名検証（登録時の JWK を使用。ヘッダ jwk は読まない）。
 * - jti（= nonce）を dbsc_challenges から一回限り消費（UPDATE changes=1 のみ成功扱い）。
 * - aud は呼び出し元 BFF の SELF_ORIGIN と一致していること。
 *
 * レスポンスは 200（成功）または 400（失敗）のみ。
 * 列挙攻撃ヒントを避けるため失敗理由は INVALID_PROOF に一本化する（ログには残す）。
 */
export async function handleDbscVerify(c: Context<{ Bindings: IdpEnv }>) {
  const result = await parseJsonBody(c, VerifySchema);
  if (!result.ok) return result.response;
  const body = result.data;

  const session = await findActiveBffSession(c.env.DB, body.session_id);
  if (!session || !session.device_public_key_jwk) {
    return c.json(
      { error: { code: "INVALID_PROOF", message: "Invalid device-bound session" } },
      400,
    );
  }

  const originErr = checkCallerOrigin(c, session.bff_origin);
  if (originErr) return originErr;

  // 保存された公開鍵を再検証つきでパース（列改ざん・破損時の異常 import を防ぐ）
  const publicJwk = parseStoredDbscPublicJwk(session.device_public_key_jwk);
  if (!publicJwk) {
    dbscVerifyLogger.error("[dbsc-verify] stored public JWK failed to parse", {
      sessionId: body.session_id,
    });
    return c.json(
      { error: { code: "INVALID_PROOF", message: "Invalid device-bound session" } },
      400,
    );
  }

  // audience は session.bff_origin を強制する（X-Internal-Secret 漏洩時の被害局所化）。
  // BFF が body で申告した値を信じると、別オリジン向けに発行された proof JWT を流用される余地が残る。
  let jti: string;
  try {
    const verified = await verifyDbscProofJwt(body.jwt, {
      publicJwk,
      audience: session.bff_origin,
    });
    // verifyDbscProofJwt 内で requiredClaims: ["aud", "jti"] を指定しているため、
    // jti が欠けた proof はここに辿り着かない。
    jti = verified.claims.jti as string;
  } catch (err) {
    const reason = err instanceof Error ? err.message : "unknown";
    dbscVerifyLogger.warn("[dbsc-verify] proof verification failed", { reason });
    return c.json({ error: { code: "INVALID_PROOF", message: "Invalid proof" } }, 400);
  }

  // nonce の一回限り消費（リプレイ対策）
  const consumed = await consumeDbscChallenge(c.env.DB, {
    nonce: jti,
    sessionId: body.session_id,
  });
  if (!consumed.ok) {
    return c.json(
      { error: { code: "INVALID_PROOF", message: "Challenge consumed or expired" } },
      400,
    );
  }

  return c.json({
    data: {
      session_id: body.session_id,
      verified_at: Math.floor(Date.now() / 1000),
    },
  });
}

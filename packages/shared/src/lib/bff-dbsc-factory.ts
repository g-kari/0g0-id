import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import type { BffEnv } from "../types";
import { parseSession } from "./bff";
import { verifyDbscRegistrationJwt, buildSecureSessionChallengeHeader } from "./dbsc";
import { internalServiceHeaders } from "./bff";
import { createLogger } from "./logger";
import { logUpstreamDeprecation } from "./internal-secret-deprecation";

/** ファクトリに渡す設定 */
export interface BffDbscConfig {
  /** セッション Cookie 名（例: "__Host-admin-session"） */
  sessionCookieName: string;
  /** ロガー名（例: "admin-dbsc"） */
  loggerName: string;
  /** 応答 JSON の credentials[].name に入れる Cookie 名 */
  credentialsCookieName: string;
}

// IdP からの challenge 応答は信頼せず zod で narrow する（応答破損で undefined アクセスを防止）
const ChallengeResponseSchema = z.object({
  data: z.object({
    nonce: z.string().min(1),
    expires_at: z.number(),
  }),
});

/**
 * Sec-Session-Response ヘッダ or リクエスト本文から proof JWT を抽出する。
 *
 * DBSC 仕様ではヘッダ値が proof JWT そのもの。ただしテスト・将来の SDK 互換のため
 * application/jwt 本文や JSON 本文 (`{ jwt: "..." }`) からのフォールバック取得も許容する。
 * 返り値が null のときは呼び出し側で 400 を返すこと。
 */
async function resolveProofJwt(
  c: {
    req: {
      header: (name: string) => string | undefined;
      text: () => Promise<string>;
      json: () => Promise<unknown>;
    };
  },
  proofHeader: string | null,
): Promise<string | null> {
  const trimmed = (proofHeader ?? "").trim();
  if (trimmed && trimmed.split(".").length === 3) return trimmed;

  const contentType = (c.req.header("Content-Type") ?? "").toLowerCase().split(";")[0]?.trim();
  if (contentType === "application/jwt") {
    const text = (await c.req.text()).trim();
    return text.split(".").length === 3 ? text : null;
  }
  if (contentType === "application/json") {
    try {
      const body = (await c.req.json()) as { jwt?: unknown };
      if (typeof body.jwt === "string") {
        const candidate = body.jwt.trim();
        if (candidate.split(".").length === 3) return candidate;
      }
    } catch {
      // 本文が壊れていても呼び出し側で 400
    }
  }
  return null;
}

/**
 * DBSC ルート（`/start` / `/refresh`）を生成するファクトリ。
 *
 * admin / user BFF で実装が完全重複していたため共通化した。差分は `sessionCookieName`
 * `loggerName` `credentialsCookieName` のみで、処理フローとセキュリティ方針（列挙攻撃
 * 対策・audience 強制・nonce ワンタイム消費）は完全に同一。Phase 3 以降で短寿命 Cookie
 * 切替を行う際もここ一箇所の修正で両 BFF に伝播する。
 */
export function createBffDbscRoutes(config: BffDbscConfig) {
  const app = new Hono<{ Bindings: BffEnv }>();
  const dbscLogger = createLogger(config.loggerName);

  /**
   * POST /auth/dbsc/start — DBSC 端末公開鍵登録（Chrome 専用フロー）
   *
   * Phase 1 仕様:
   * 1. ブラウザは登録 JWT（ヘッダの jwk に端末公開鍵を含む自署 JWS）を本文に送る。
   * 2. サーバは JWT を検証し、bff_sessions に公開鍵を結びつける（IdP の internal API 経由）。
   * 3. Phase 1 では短寿命 Cookie・チャレンジ・リフレッシュは発行しない（Phase 2 で実装）。
   */
  app.post("/start", async (c) => {
    const session = await parseSession(
      getCookie(c, config.sessionCookieName),
      c.env.SESSION_SECRET,
    );
    if (!session) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "No session" } }, 401);
    }

    const contentType = (c.req.header("Content-Type") ?? "").toLowerCase().split(";")[0]?.trim();
    let jwt: string;
    if (contentType === "application/jwt") {
      jwt = (await c.req.text()).trim();
    } else {
      // JSON 形式 ({ jwt: "..." }) も受け付ける（テスト・将来の SDK 互換用）。
      try {
        const body = (await c.req.json()) as { jwt?: unknown };
        if (typeof body.jwt !== "string") {
          return c.json({ error: { code: "INVALID_REQUEST", message: "Missing jwt" } }, 400);
        }
        jwt = body.jwt.trim();
      } catch {
        return c.json({ error: { code: "INVALID_REQUEST", message: "Invalid body" } }, 400);
      }
    }

    if (!jwt) {
      return c.json({ error: { code: "INVALID_REQUEST", message: "Empty jwt" } }, 400);
    }

    let publicJwk;
    try {
      const verified = await verifyDbscRegistrationJwt(jwt, { audience: c.env.SELF_ORIGIN });
      publicJwk = verified.publicJwk;
    } catch (err) {
      const reason = err instanceof Error ? err.message : "unknown";
      dbscLogger.warn("[dbsc-start] JWT verification failed", { reason });
      return c.json({ error: { code: "INVALID_JWT", message: "Invalid registration JWT" } }, 400);
    }

    const bindResp = await c.env.IDP.fetch(
      new Request(`${c.env.IDP_ORIGIN}/auth/dbsc/bind`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // IdP 側で session.bff_origin と一致確認するための呼び出し元宣言。
          "X-BFF-Origin": c.env.SELF_ORIGIN,
          ...internalServiceHeaders(c.env),
        },
        body: JSON.stringify({ session_id: session.session_id, public_jwk: publicJwk }),
      }),
    );
    logUpstreamDeprecation(bindResp, { method: "POST", path: "/auth/dbsc/bind" }, dbscLogger);

    if (!bindResp.ok) {
      dbscLogger.warn("[dbsc-start] IdP bind failed", { status: bindResp.status });
      // 列挙攻撃ヒント（INVALID_SESSION か ALREADY_BOUND かの区別）を外向きに与えないため、
      // 4xx はすべて INVALID_REQUEST に畳む。5xx のみ運用判断用に区別する。
      if (bindResp.status >= 500) {
        return c.json(
          { error: { code: "INTERNAL_ERROR", message: "Failed to bind device key" } },
          500,
        );
      }
      return c.json(
        { error: { code: "INVALID_REQUEST", message: "Cannot bind this session" } },
        400,
      );
    }

    // Phase 2 用にプレースホルダ scope/refresh_url を返す。
    // Chrome は応答 JSON を parse して以降のリフレッシュ動線を組み立てる。
    return c.json({
      session_identifier: session.session_id,
      refresh_url: "/auth/dbsc/refresh",
      scope: { include_site: true },
      credentials: [{ type: "cookie", name: config.credentialsCookieName }],
    });
  });

  /**
   * POST /auth/dbsc/refresh — DBSC challenge-response リフレッシュ
   *
   * Phase 2 フロー:
   * 1. 初回 POST（Sec-Session-Response なし）→ IdP で nonce 発行 →
   *    `403 Forbidden` + `Secure-Session-Challenge: "<nonce>"` で応答。
   * 2. Chrome は端末秘密鍵で nonce を含む proof JWT を署名し再送。
   * 3. 署名を IdP で検証 → nonce をワンタイム消費 → 200。
   *
   * Phase 2 時点では既存の長寿命 Cookie を据え置き、DBSC 検証の成功/失敗のみを返す。
   * 短寿命 Cookie への切替と機密操作必須化は Phase 3 で行う。
   *
   * CSRF 対策:
   * - セッション Cookie を必須とすることで、ログイン済みユーザーのブラウザ以外を排除。
   * - aud=SELF_ORIGIN を proof JWT に要求することで、他オリジン向け JWT のリプレイを防止。
   * - nonce はセッション単位で発行・消費し、他セッションへの流用を禁じる。
   */
  app.post("/refresh", async (c) => {
    const session = await parseSession(
      getCookie(c, config.sessionCookieName),
      c.env.SESSION_SECRET,
    );
    if (!session) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "No session" } }, 401);
    }

    const proofHeader = c.req.header("Sec-Session-Response") ?? null;

    // Phase 1: proof 未提示 → challenge を発行
    if (!proofHeader) {
      const challengeResp = await c.env.IDP.fetch(
        new Request(`${c.env.IDP_ORIGIN}/auth/dbsc/challenge`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-BFF-Origin": c.env.SELF_ORIGIN,
            ...internalServiceHeaders(c.env),
          },
          body: JSON.stringify({ session_id: session.session_id }),
        }),
      );
      logUpstreamDeprecation(
        challengeResp,
        { method: "POST", path: "/auth/dbsc/challenge" },
        dbscLogger,
      );

      if (!challengeResp.ok) {
        dbscLogger.warn("[dbsc-refresh] challenge issue failed", { status: challengeResp.status });
        if (challengeResp.status >= 500) {
          return c.json(
            { error: { code: "INTERNAL_ERROR", message: "Failed to issue challenge" } },
            500,
          );
        }
        // 端末未バインドや失効は INVALID_REQUEST に畳む（列挙攻撃対策）
        return c.json(
          { error: { code: "INVALID_REQUEST", message: "Cannot issue challenge" } },
          400,
        );
      }

      let parsedBody: unknown;
      try {
        parsedBody = await challengeResp.json();
      } catch (err) {
        dbscLogger.error("[dbsc-refresh] challenge response JSON parse failed", err);
        return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
      }
      const parsed = ChallengeResponseSchema.safeParse(parsedBody);
      if (!parsed.success) {
        dbscLogger.error("[dbsc-refresh] challenge response shape invalid");
        return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
      }

      let headerValue: string;
      try {
        headerValue = buildSecureSessionChallengeHeader(parsed.data.data.nonce);
      } catch (err) {
        dbscLogger.error("[dbsc-refresh] invalid nonce shape", err);
        return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
      }

      c.header("Secure-Session-Challenge", headerValue);
      return c.json(
        { error: { code: "SESSION_CHALLENGE_REQUIRED", message: "Challenge issued" } },
        403,
      );
    }

    // Phase 2: proof JWT を検証
    const jwt = await resolveProofJwt(c, proofHeader);
    if (!jwt) {
      return c.json({ error: { code: "INVALID_REQUEST", message: "Invalid proof form" } }, 400);
    }

    // audience は IdP 側で session.bff_origin を強制するため、body には含めない。
    const verifyResp = await c.env.IDP.fetch(
      new Request(`${c.env.IDP_ORIGIN}/auth/dbsc/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-BFF-Origin": c.env.SELF_ORIGIN,
          ...internalServiceHeaders(c.env),
        },
        body: JSON.stringify({
          session_id: session.session_id,
          jwt,
        }),
      }),
    );
    logUpstreamDeprecation(verifyResp, { method: "POST", path: "/auth/dbsc/verify" }, dbscLogger);

    if (!verifyResp.ok) {
      dbscLogger.warn("[dbsc-refresh] verify failed", { status: verifyResp.status });
      if (verifyResp.status >= 500) {
        return c.json(
          { error: { code: "INTERNAL_ERROR", message: "Failed to verify proof" } },
          500,
        );
      }
      // proof 失敗や challenge リプレイは INVALID_PROOF で返す（列挙攻撃対策で詳細は返さない）
      return c.json({ error: { code: "INVALID_PROOF", message: "Invalid proof" } }, 400);
    }

    // Phase 2 では既存 Cookie をそのまま据え置く。
    // Phase 3 で短寿命 Cookie（例: 10分）への切替と拡張応答を行う。
    return c.json({
      session_identifier: session.session_id,
      refresh_url: "/auth/dbsc/refresh",
      scope: { include_site: true },
      credentials: [{ type: "cookie", name: config.credentialsCookieName }],
    });
  });

  return app;
}

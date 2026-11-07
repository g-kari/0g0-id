import { Hono } from "hono";
import {
  createService,
  findServiceByClientId,
  updateDcrClientFields,
  deleteService,
  listRedirectUris,
  addRedirectUri,
  deleteRedirectUri,
  revokeAllServiceTokens,
  generateClientId,
  generateToken,
  sha256,
  timingSafeEqual,
  normalizeRedirectUri,
  createLogger,
} from "@0g0-id/shared";
import type { IdpEnv, Service } from "@0g0-id/shared";
import { authRateLimitMiddleware } from "../middleware/rate-limit";

const registerLogger = createLogger("register");

const app = new Hono<{ Bindings: IdpEnv }>();

/**
 * RFC 7591 動的クライアント登録 (Dynamic Client Registration) と
 * RFC 7592 クライアント構成エンドポイント。
 *
 * 設計判断:
 * - 登録は無認証で受け付ける。MCP クライアント（ChatGPT 等）は登録前に
 *   初期アクセストークンを取得する手段がないため、初期アクセストークン
 *   必須にはできない。代わりに濫用対策として次を課す:
 *   - 公開クライアントのみ（token_endpoint_auth_method = "none"、PKCE S256 必須）
 *   - 付与スコープは OIDC の scopes_supported の範囲内のみ
 *     （リソース向けスコープはリソースサーバー側の登録でのみ有効になる）
 *   - redirect URI は https 必須（localhost のみ http 可）、件数上限あり
 *   - IP 単位のレート制限（RATE_LIMITER_AUTH と共用）
 *   - 管理者は /api/services の一覧（source = "dcr"）からいつでも削除できる
 * - 登録されたクライアントは services テーブルに source = "dcr" で保存され、
 *   所有者はマイグレーション 0028 で作る専用システムユーザーが担う。
 */

/** マイグレーション 0028 で作成される DCR 用システムユーザーの ID */
const DCR_SYSTEM_OWNER_ID = "system-dcr-owner";

/** redirect URI の登録上限（濫用対策） */
const MAX_REDIRECT_URIS = 5;

/** DCR で付与できるスコープ（openid は常に暗黙に利用可能） */
const DCR_GRANTABLE_SCOPES = ["profile", "email", "phone", "address"] as const;
const DCR_DEFAULT_SCOPES = ["profile", "email"];

type RegisterError = { error: string; error_description: string };

function errorResponse(error: string, description: string, status: 400 | 401 | 404) {
  return { body: { error, error_description: description } as RegisterError, status };
}

interface ClientMetadata {
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  storedScopes: string[];
}

/**
 * RFC 7591 のクライアントメタデータを検証し、正規化した値を返す。
 * 問題があれば RFC 7591 §3.2.2 のエラー（invalid_redirect_uri /
 * invalid_client_metadata）を返す。
 */
function validateClientMetadata(
  body: Record<string, unknown>,
): { ok: true; metadata: ClientMetadata } | { ok: false; error: string; description: string } {
  // redirect_uris（必須・https 必須・localhost のみ http 可・件数上限）
  const rawUris = body["redirect_uris"];
  if (!Array.isArray(rawUris) || rawUris.length === 0) {
    return {
      ok: false,
      error: "invalid_redirect_uri",
      description: "redirect_uris must be a non-empty array",
    };
  }
  if (rawUris.length > MAX_REDIRECT_URIS) {
    return {
      ok: false,
      error: "invalid_redirect_uri",
      description: `redirect_uris must contain at most ${MAX_REDIRECT_URIS} URIs`,
    };
  }
  const redirectUris: string[] = [];
  for (const raw of rawUris) {
    if (typeof raw !== "string" || raw.length > 2048) {
      return { ok: false, error: "invalid_redirect_uri", description: "invalid redirect_uri" };
    }
    const normalized = normalizeRedirectUri(raw);
    if (!normalized) {
      return {
        ok: false,
        error: "invalid_redirect_uri",
        description: "redirect_uri must be an https URL (http is allowed only for localhost)",
      };
    }
    if (!redirectUris.includes(normalized)) redirectUris.push(normalized);
  }

  // grant_types（authorization_code / refresh_token のみ。refresh は code とセット）
  const rawGrants = body["grant_types"] ?? ["authorization_code", "refresh_token"];
  if (
    !Array.isArray(rawGrants) ||
    rawGrants.length === 0 ||
    !rawGrants.every((g) => g === "authorization_code" || g === "refresh_token")
  ) {
    return {
      ok: false,
      error: "invalid_client_metadata",
      description: "grant_types must be a subset of [authorization_code, refresh_token]",
    };
  }
  if (rawGrants.includes("refresh_token") && !rawGrants.includes("authorization_code")) {
    return {
      ok: false,
      error: "invalid_client_metadata",
      description: "refresh_token grant requires authorization_code grant",
    };
  }
  const grantTypes = [...new Set(rawGrants as string[])];

  // response_types（code のみ）
  const rawResponseTypes = body["response_types"] ?? ["code"];
  if (
    !Array.isArray(rawResponseTypes) ||
    rawResponseTypes.length === 0 ||
    !rawResponseTypes.every((r) => r === "code")
  ) {
    return {
      ok: false,
      error: "invalid_client_metadata",
      description: "response_types must be [code]",
    };
  }

  // token_endpoint_auth_method（公開クライアントのみ）
  const authMethod = body["token_endpoint_auth_method"] ?? "none";
  if (authMethod !== "none") {
    return {
      ok: false,
      error: "invalid_client_metadata",
      description: "only token_endpoint_auth_method=none (public client) is supported",
    };
  }

  // scope（OIDC の scopes_supported の範囲内のみ。過剰要求は拒否）
  let storedScopes = [...DCR_DEFAULT_SCOPES];
  const rawScope = body["scope"];
  if (rawScope !== undefined) {
    if (typeof rawScope !== "string") {
      return { ok: false, error: "invalid_client_metadata", description: "scope must be a string" };
    }
    const requested = rawScope.split(" ").filter(Boolean);
    const unsupported = requested.filter(
      (s) => s !== "openid" && !(DCR_GRANTABLE_SCOPES as readonly string[]).includes(s),
    );
    if (unsupported.length > 0) {
      return {
        ok: false,
        error: "invalid_client_metadata",
        description: `scope not supported for dynamic registration: ${unsupported.join(" ")}`,
      };
    }
    storedScopes = [...new Set(requested.filter((s) => s !== "openid"))];
  }

  // client_name（任意・長さ上限）
  const rawName = body["client_name"];
  if (rawName !== undefined && (typeof rawName !== "string" || rawName.length > 100)) {
    return {
      ok: false,
      error: "invalid_client_metadata",
      description: "client_name must be a string of at most 100 characters",
    };
  }
  const clientName =
    typeof rawName === "string" && rawName.trim() ? rawName.trim() : "Dynamic Client";

  return { ok: true, metadata: { clientName, redirectUris, grantTypes, storedScopes } };
}

/** 登録レスポンス（RFC 7591 §3.2.1 / RFC 7592 §3.2）の組み立て */
async function clientMetadataResponse(
  db: D1Database,
  env: IdpEnv,
  service: Service,
  grantTypes: string[],
  registrationAccessToken?: string,
) {
  const uris = await listRedirectUris(db, service.id);
  const response: Record<string, unknown> = {
    client_id: service.client_id,
    client_id_issued_at: Math.floor(new Date(service.created_at).getTime() / 1000),
    client_name: service.name,
    redirect_uris: uris.map((u) => u.uri),
    grant_types: grantTypes,
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: ["openid", ...JSON.parse(service.allowed_scopes)].join(" "),
    registration_client_uri: `${env.IDP_ORIGIN}/api/register/${service.client_id}`,
  };
  if (registrationAccessToken) {
    response["registration_access_token"] = registrationAccessToken;
  }
  return response;
}

/** 格納済み grant_types は持たないため、レスポンス用に固定値を返す */
const DEFAULT_GRANT_TYPES = ["authorization_code", "refresh_token"];

// POST /api/register — RFC 7591 クライアント登録
app.post("/", authRateLimitMiddleware, async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    const { body: errBody, status } = errorResponse(
      "invalid_client_metadata",
      "JSON body required",
      400,
    );
    return c.json(errBody, status);
  }

  const validated = validateClientMetadata(body ?? {});
  if (!validated.ok) {
    const { body: errBody, status } = errorResponse(validated.error, validated.description, 400);
    return c.json(errBody, status);
  }
  const { metadata } = validated;

  const registrationAccessToken = generateToken(32);
  let service: Service;
  try {
    service = await createService(c.env.DB, {
      id: crypto.randomUUID(),
      name: metadata.clientName,
      clientId: generateClientId(),
      // 公開クライアント: シークレットなし（空文字 = public として扱う既存規約）
      clientSecretHash: "",
      allowedScopes: JSON.stringify(metadata.storedScopes),
      ownerUserId: DCR_SYSTEM_OWNER_ID,
      source: "dcr",
      registrationAccessTokenHash: await sha256(registrationAccessToken),
    });
    for (const uri of metadata.redirectUris) {
      await addRedirectUri(c.env.DB, {
        id: crypto.randomUUID(),
        serviceId: service.id,
        uri,
      });
    }
  } catch (err) {
    registerLogger.error("[register] Failed to register client", err);
    const { body: errBody, status } = errorResponse(
      "invalid_client_metadata",
      "Failed to register client",
      400,
    );
    return c.json(errBody, status);
  }

  const response = await clientMetadataResponse(
    c.env.DB,
    c.env,
    service,
    metadata.grantTypes,
    registrationAccessToken,
  );
  return c.json(response, 201);
});

/**
 * RFC 7592: registration_access_token によるクライアント所有確認。
 * DCR で登録されたクライアント（source = "dcr"）以外は対象外。
 */
async function authenticateRegistration(
  db: D1Database,
  clientId: string,
  authHeader: string | undefined,
): Promise<
  | { ok: true; service: Service }
  | { ok: false; status: 401 | 404; error: string; description: string }
> {
  const service = await findServiceByClientId(db, clientId);
  if (!service || service.source !== "dcr" || !service.registration_access_token_hash) {
    return {
      ok: false,
      status: 404,
      error: "invalid_client",
      description: "client not found or not dynamically registered",
    };
  }
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
  if (!token) {
    return {
      ok: false,
      status: 401,
      error: "invalid_token",
      description: "registration_access_token is required",
    };
  }
  const presentedHash = await sha256(token);
  if (!timingSafeEqual(presentedHash, service.registration_access_token_hash)) {
    return {
      ok: false,
      status: 401,
      error: "invalid_token",
      description: "registration_access_token is invalid",
    };
  }
  return { ok: true, service };
}

// GET /api/register/:clientId — RFC 7592 クライアント構成の読み取り
app.get("/:clientId", async (c) => {
  const auth = await authenticateRegistration(
    c.env.DB,
    c.req.param("clientId"),
    c.req.header("Authorization"),
  );
  if (!auth.ok) {
    const { body, status } = errorResponse(auth.error, auth.description, auth.status);
    return c.json(body, status);
  }
  const response = await clientMetadataResponse(c.env.DB, c.env, auth.service, DEFAULT_GRANT_TYPES);
  return c.json(response, 200);
});

// PUT /api/register/:clientId — RFC 7592 クライアント構成の更新
app.put("/:clientId", authRateLimitMiddleware, async (c) => {
  const auth = await authenticateRegistration(
    c.env.DB,
    c.req.param("clientId"),
    c.req.header("Authorization"),
  );
  if (!auth.ok) {
    const { body, status } = errorResponse(auth.error, auth.description, auth.status);
    return c.json(body, status);
  }

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    const { body: errBody, status } = errorResponse(
      "invalid_client_metadata",
      "JSON body required",
      400,
    );
    return c.json(errBody, status);
  }
  // RFC 7592 §3.2: 更新リクエストの client_id は URI と一致すること
  if (body["client_id"] !== undefined && body["client_id"] !== auth.service.client_id) {
    const { body: errBody, status } = errorResponse(
      "invalid_client_metadata",
      "client_id does not match the configuration URI",
      400,
    );
    return c.json(errBody, status);
  }

  const validated = validateClientMetadata(body ?? {});
  if (!validated.ok) {
    const { body: errBody, status } = errorResponse(validated.error, validated.description, 400);
    return c.json(errBody, status);
  }
  const { metadata } = validated;

  try {
    const updated = await updateDcrClientFields(c.env.DB, auth.service.id, {
      name: metadata.clientName,
      allowedScopes: JSON.stringify(metadata.storedScopes),
    });
    if (!updated) throw new Error("update failed");
    // redirect URI は全置換
    const existing = await listRedirectUris(c.env.DB, auth.service.id);
    for (const uri of existing) {
      await deleteRedirectUri(c.env.DB, uri.id, auth.service.id);
    }
    for (const uri of metadata.redirectUris) {
      await addRedirectUri(c.env.DB, {
        id: crypto.randomUUID(),
        serviceId: auth.service.id,
        uri,
      });
    }
    const response = await clientMetadataResponse(c.env.DB, c.env, updated, metadata.grantTypes);
    return c.json(response, 200);
  } catch (err) {
    registerLogger.error("[register] Failed to update client", err);
    const { body: errBody, status } = errorResponse(
      "invalid_client_metadata",
      "Failed to update client",
      400,
    );
    return c.json(errBody, status);
  }
});

// DELETE /api/register/:clientId — RFC 7592 クライアントの削除
app.delete("/:clientId", async (c) => {
  const auth = await authenticateRegistration(
    c.env.DB,
    c.req.param("clientId"),
    c.req.header("Authorization"),
  );
  if (!auth.ok) {
    const { body, status } = errorResponse(auth.error, auth.description, auth.status);
    return c.json(body, status);
  }
  try {
    await revokeAllServiceTokens(c.env.DB, auth.service.id);
    await deleteService(c.env.DB, auth.service.id);
  } catch (err) {
    registerLogger.error("[register] Failed to delete client", err);
    const { body: errBody, status } = errorResponse(
      "invalid_client_metadata",
      "Failed to delete client",
      400,
    );
    return c.json(errBody, status);
  }
  return c.body(null, 204);
});

export default app;

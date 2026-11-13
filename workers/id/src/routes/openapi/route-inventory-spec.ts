// Documentation only. These path items describe handlers that are already mounted.
// They do not change authentication, validation, or responses.

const bearer = [{ BearerAuth: [] }];
const oauthError = { $ref: "#/components/schemas/OAuthError" };
const restError = { $ref: "#/components/schemas/Error" };

const userId = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
  description: "対象ユーザーID。UUID 以外は 400。",
};

const daysQuery = {
  name: "days",
  in: "query",
  required: false,
  schema: { type: "string" },
  description: "省略時 30。数字のみ、1〜365。範囲外・非数字は 400。",
};

function dataResponse(description: string, data: object, extra: object = {}) {
  return {
    description,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["data", ...Object.keys(extra)],
          properties: { data, ...extra },
        },
      },
    },
  };
}

const providerStat = {
  type: "object",
  required: ["provider", "count"],
  properties: {
    provider: { type: "string" },
    count: { type: "integer", minimum: 0 },
  },
};

const dailyStat = {
  type: "object",
  required: ["date", "count"],
  properties: {
    date: { type: "string", description: "YYYY-MM-DD。0件の日は含まない。" },
    count: { type: "integer", minimum: 0 },
  },
};

const adminAuth = {
  security: bearer,
  responses: {
    "401": { description: "UNAUTHORIZED" },
    "403": { description: "FORBIDDEN — 管理者権限なし" },
  },
};

const selfAuth = {
  security: bearer,
  responses: {
    "401": { description: "UNAUTHORIZED — 未認証、ユーザー未存在、または BAN 済み" },
    "403": { description: "FORBIDDEN — サービス用トークン" },
  },
};

/** RFC 7591 / RFC 7592 public-client registration. Shared by the internal and external specs. */
export const DCR_PATHS = {
  "/api/register": {
    post: {
      tags: ["動的クライアント登録"],
      summary: "公開クライアントの動的登録",
      description:
        "RFC 7591。初期アクセストークンは不要。受け付けるのは token_endpoint_auth_method=none の公開クライアントだけで、PKCE S256 を使う。redirect_uris は 1〜5 件、https（localhost のみ http）、fragment 不可。grant_types は authorization_code と refresh_token のみで、refresh_token には authorization_code が必要。response_types は code のみ。scope は openid と profile/email/phone/address。省略時の保存スコープは profile と email。client_name は任意で最大 100 文字、空なら Dynamic Client。機密クライアントは管理者が /api/services で登録する。登録主体は DCR 用システムユーザー。",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["redirect_uris"],
              properties: {
                redirect_uris: {
                  type: "array",
                  minItems: 1,
                  maxItems: 5,
                  items: { type: "string", maxLength: 2048 },
                },
                grant_types: {
                  type: "array",
                  items: { type: "string", enum: ["authorization_code", "refresh_token"] },
                },
                response_types: { type: "array", items: { type: "string", enum: ["code"] } },
                token_endpoint_auth_method: { type: "string", enum: ["none"] },
                scope: { type: "string" },
                client_name: { type: "string", maxLength: 100 },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description:
            "登録成功。registration_access_token はこの応答にだけ含まれ、再表示しない。registration_client_uri は /api/register/{client_id}。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: [
                  "client_id",
                  "client_id_issued_at",
                  "client_name",
                  "redirect_uris",
                  "grant_types",
                  "response_types",
                  "token_endpoint_auth_method",
                  "scope",
                  "registration_client_uri",
                  "registration_access_token",
                ],
                properties: {
                  client_id: { type: "string" },
                  client_id_issued_at: { type: "integer" },
                  client_name: { type: "string" },
                  redirect_uris: { type: "array", items: { type: "string" } },
                  grant_types: { type: "array", items: { type: "string" } },
                  response_types: { type: "array", items: { type: "string", enum: ["code"] } },
                  token_endpoint_auth_method: { type: "string", enum: ["none"] },
                  scope: { type: "string" },
                  registration_client_uri: { type: "string" },
                  registration_access_token: { type: "string" },
                },
              },
            },
          },
        },
        "400": {
          description:
            "invalid_redirect_uri または invalid_client_metadata。JSON 以外、保存失敗も同じ形式。",
          content: { "application/json": { schema: oauthError } },
        },
      },
    },
  },
  "/api/register/{clientId}": {
    get: {
      tags: ["動的クライアント登録"],
      summary: "動的クライアント構成の読み取り",
      description:
        "RFC 7592。Authorization: Bearer は registration_access_token であり、ユーザー用 JWT ではない。source=dcr 以外、またはトークン不一致はクライアントの存否を分けず 404/401。応答に registration_access_token は含めない。grant_types は保存値ではなく authorization_code と refresh_token を返す。",
      parameters: [
        {
          name: "clientId",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "登録時に発行した client_id。",
        },
      ],
      responses: {
        "200": {
          description: "クライアントメタデータ。registration_access_token は含まない。",
          content: { "application/json": { schema: { type: "object" } } },
        },
        "401": {
          description: "invalid_token — registration_access_token が無い、または不一致。",
          content: { "application/json": { schema: oauthError } },
        },
        "404": {
          description: "invalid_client — 未登録、または DCR クライアントではない。",
          content: { "application/json": { schema: oauthError } },
        },
      },
    },
    put: {
      tags: ["動的クライアント登録"],
      summary: "動的クライアント構成の置換",
      description:
        "RFC 7592。認証は GET と同じ registration_access_token。redirect URI は全置換。body の client_id を付けた場合はパスの client_id と一致が必要。client_secret は発行しない。",
      parameters: [
        {
          name: "clientId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { type: "object" } } },
      },
      responses: {
        "200": { description: "更新後のメタデータ。registration_access_token は含まない。" },
        "400": {
          description:
            "invalid_client_metadata / invalid_redirect_uri。JSON 以外や client_id 不一致を含む。",
          content: { "application/json": { schema: oauthError } },
        },
        "401": {
          description: "invalid_token",
          content: { "application/json": { schema: oauthError } },
        },
        "404": {
          description: "invalid_client",
          content: { "application/json": { schema: oauthError } },
        },
      },
    },
    delete: {
      tags: ["動的クライアント登録"],
      summary: "動的クライアントの削除",
      description:
        "RFC 7592。認証は GET と同じ。削除前にそのクライアントのトークンを失効する。成功は本文なし。",
      parameters: [
        {
          name: "clientId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        "204": { description: "削除成功" },
        "400": {
          description: "削除処理の失敗。invalid_client_metadata。",
          content: { "application/json": { schema: oauthError } },
        },
        "401": {
          description: "invalid_token",
          content: { "application/json": { schema: oauthError } },
        },
        "404": {
          description: "invalid_client",
          content: { "application/json": { schema: oauthError } },
        },
      },
    },
  },
};

const resource = {
  type: "object",
  required: [
    "id",
    "uri",
    "name",
    "allowed_scopes",
    "allowed_subjects",
    "owner_user_id",
    "created_at",
    "updated_at",
  ],
  properties: {
    id: { type: "string" },
    uri: { type: "string", description: "https で fragment なし。登録時に正規化した値。" },
    name: { type: "string" },
    allowed_scopes: {
      type: "string",
      description: "JSON 配列の文字列。応答ではパースしない。",
    },
    allowed_subjects: {
      type: "string",
      description: "JSON 配列の文字列。空配列は利用ユーザー制限なし。",
    },
    owner_user_id: { type: "string" },
    created_at: { type: "string" },
    updated_at: { type: "string" },
  },
};

const bffOrigin = {
  name: "X-BFF-Origin",
  in: "header",
  required: true,
  schema: { type: "string" },
  description: "呼び出し元 BFF のオリジン。セッションの bff_origin と一致が必要。",
};

const dbscSession = {
  type: "object",
  required: ["session_id"],
  properties: {
    session_id: { type: "string", minLength: 1, maxLength: 128 },
  },
};

export const ROUTE_INVENTORY_PATHS = {
  ...DCR_PATHS,
  "/api/resources": {
    get: {
      tags: ["リソースサーバー"],
      summary: "リソースサーバー一覧",
      description:
        "RFC 8707 の resource として受け付ける URI の管理者一覧。Bearer と admin ロール。",
      security: bearer,
      responses: {
        "200": dataResponse(
          "登録済みリソースサーバー",
          { type: "array", items: resource },
          {
            total: { type: "integer", minimum: 0 },
          },
        ),
        "401": adminAuth.responses["401"],
        "403": adminAuth.responses["403"],
        "500": {
          description: "INTERNAL_ERROR",
          content: { "application/json": { schema: restError } },
        },
      },
    },
    post: {
      tags: ["リソースサーバー"],
      summary: "リソースサーバー登録",
      description:
        "管理者専用。CSRF（Origin/Referer）。uri は認可フローと同じ正規化（https、fragment 不可）。重複 URI は 400。allowed_subjects 省略時は空配列（制限なし）。監査ログ resource.create を残す。",
      security: bearer,
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["uri", "name", "allowed_scopes"],
              properties: {
                uri: { type: "string", minLength: 1, maxLength: 2048 },
                name: { type: "string", minLength: 1, maxLength: 100 },
                allowed_scopes: {
                  type: "array",
                  minItems: 1,
                  maxItems: 50,
                  items: { type: "string", maxLength: 100 },
                },
                allowed_subjects: {
                  type: "array",
                  maxItems: 100,
                  items: { type: "string", minLength: 1, maxLength: 128 },
                },
              },
            },
          },
        },
      },
      responses: {
        "201": dataResponse("作成したリソースサーバー", resource),
        "400": { description: "VALIDATION_ERROR、不正 URI、または URI 重複" },
        "401": adminAuth.responses["401"],
        "403": { description: "FORBIDDEN — 管理者権限なし、またはオリジン不正" },
        "500": { description: "INTERNAL_ERROR" },
      },
    },
  },
  "/api/resources/{id}": {
    get: {
      tags: ["リソースサーバー"],
      summary: "リソースサーバー詳細",
      security: bearer,
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": dataResponse("リソースサーバー", resource),
        "401": adminAuth.responses["401"],
        "403": adminAuth.responses["403"],
        "404": { description: "NOT_FOUND" },
        "500": { description: "INTERNAL_ERROR" },
      },
    },
    put: {
      tags: ["リソースサーバー"],
      summary: "リソースサーバー更新",
      description:
        "管理者専用。CSRF。name、allowed_scopes、allowed_subjects を更新する。URI は変えない。監査ログ resource.update。",
      security: bearer,
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["name", "allowed_scopes", "allowed_subjects"],
              properties: {
                name: { type: "string", minLength: 1, maxLength: 100 },
                allowed_scopes: {
                  type: "array",
                  minItems: 1,
                  maxItems: 50,
                  items: { type: "string" },
                },
                allowed_subjects: { type: "array", maxItems: 100, items: { type: "string" } },
              },
            },
          },
        },
      },
      responses: {
        "200": dataResponse("更新後のリソースサーバー", resource),
        "400": { description: "VALIDATION_ERROR" },
        "401": adminAuth.responses["401"],
        "403": { description: "FORBIDDEN — 管理者権限なし、またはオリジン不正" },
        "404": { description: "NOT_FOUND" },
        "500": { description: "INTERNAL_ERROR" },
      },
    },
    delete: {
      tags: ["リソースサーバー"],
      summary: "リソースサーバー削除",
      description:
        "管理者専用。CSRF。同じ処理で、その resource に束縛されたリフレッシュトークンを失効する。再登録しても旧 grant は戻らない。成功は本文なし。監査ログ resource.delete。",
      security: bearer,
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "204": { description: "削除成功" },
        "401": adminAuth.responses["401"],
        "403": { description: "FORBIDDEN — 管理者権限なし、またはオリジン不正" },
        "404": { description: "NOT_FOUND" },
        "500": { description: "INTERNAL_ERROR" },
      },
    },
  },
  "/api/users/me/data-export": {
    get: {
      tags: ["ユーザー API"],
      summary: "自分のアカウントデータ一括取得",
      description:
        "認証済み本人のみ。サービス用トークンと BAN 済みは不可。プロフィール、連携プロバイダー、連携サービス、直近 1000 件のログイン履歴、アクティブセッションを返す。",
      security: bearer,
      responses: {
        "200": dataResponse("エクスポート", {
          type: "object",
          required: [
            "exported_at",
            "profile",
            "providers",
            "service_connections",
            "login_history",
            "active_sessions",
          ],
          properties: {
            exported_at: { type: "string", format: "date-time" },
            profile: {
              type: "object",
              required: [
                "id",
                "email",
                "email_verified",
                "name",
                "picture",
                "phone",
                "address",
                "role",
                "created_at",
                "updated_at",
              ],
              properties: {
                id: { type: "string" },
                email: { type: "string" },
                email_verified: { type: "boolean" },
                name: { type: "string" },
                picture: { type: ["string", "null"] },
                phone: { type: ["string", "null"] },
                address: { type: ["string", "null"] },
                role: { type: "string" },
                created_at: { type: "string" },
                updated_at: { type: "string" },
              },
            },
            providers: { type: "array", items: { type: "object" } },
            service_connections: { type: "array", items: { type: "object" } },
            login_history: { type: "array", items: { type: "object" } },
            active_sessions: { type: "array", items: { type: "object" } },
          },
        }),
        "401": selfAuth.responses["401"],
        "403": selfAuth.responses["403"],
        "500": { description: "INTERNAL_ERROR — 関連データの取得失敗" },
      },
    },
  },
  "/api/users/me/login-stats": {
    get: {
      tags: ["ユーザー API"],
      summary: "自分のプロバイダー別ログイン統計",
      description:
        "本人のみ。days 省略時 30、1〜365。ログイン 0 件のプロバイダーは含まない。不正な days の 400 は code=BAD_REQUEST だが、message は文字列ではなく parseDays の { code: INVALID_REQUEST, message } オブジェクト。",
      security: bearer,
      parameters: [daysQuery],
      responses: {
        "200": dataResponse(
          "プロバイダー別件数",
          { type: "array", items: providerStat },
          { days: { type: "integer", minimum: 1, maximum: 365 } },
        ),
        "400": {
          description: "BAD_REQUEST。message は { code: INVALID_REQUEST, message: string }。",
        },
        "401": selfAuth.responses["401"],
        "403": selfAuth.responses["403"],
      },
    },
  },
  "/api/users/me/login-trends": {
    get: {
      tags: ["ユーザー API"],
      summary: "自分の日別ログイントレンド",
      description:
        "本人のみ。days は login-stats と同じ。0 件の日は補完しない。不正 days の message 形状も login-stats と同じオブジェクト。",
      security: bearer,
      parameters: [daysQuery],
      responses: {
        "200": dataResponse(
          "日別件数",
          { type: "array", items: dailyStat },
          { days: { type: "integer", minimum: 1, maximum: 365 } },
        ),
        "400": { description: "BAD_REQUEST。message は INVALID_REQUEST オブジェクト。" },
        "401": selfAuth.responses["401"],
        "403": selfAuth.responses["403"],
      },
    },
  },
  "/api/users/me/security-summary": {
    get: {
      tags: ["ユーザー API"],
      summary: "自分のセキュリティ概要",
      description: "本人のみ。最後のログインが無い場合 last_login は null。",
      security: bearer,
      responses: {
        "200": dataResponse("セキュリティ概要", {
          type: "object",
          required: [
            "active_sessions_count",
            "connected_services_count",
            "linked_providers",
            "last_login",
            "account_created_at",
          ],
          properties: {
            active_sessions_count: { type: "integer", minimum: 0 },
            connected_services_count: { type: "integer", minimum: 0 },
            linked_providers: { type: "array", items: { type: "string" } },
            last_login: {
              type: ["object", "null"],
              required: ["provider", "ip_address", "created_at"],
              properties: {
                provider: { type: "string" },
                ip_address: { type: ["string", "null"] },
                created_at: { type: "string" },
              },
            },
            account_created_at: { type: "string" },
          },
        }),
        "401": selfAuth.responses["401"],
        "403": selfAuth.responses["403"],
        "500": { description: "INTERNAL_ERROR" },
      },
    },
  },
  "/api/users/me/tokens/others": {
    delete: {
      tags: ["ユーザー API"],
      summary: "現在以外のリフレッシュトークンを失効",
      description:
        "本人のみ。CSRF。body の token_hash は残すセッションのリフレッシュトークン SHA-256。パスの others はリテラルで、トークン ID ではない。BFF セッションと MCP セッションはこの操作では失効しない。",
      security: bearer,
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["token_hash"],
              properties: { token_hash: { type: "string", minLength: 1 } },
            },
          },
        },
      },
      responses: {
        "200": dataResponse("失効件数", {
          type: "object",
          required: ["revoked_count"],
          properties: { revoked_count: { type: "integer", minimum: 0 } },
        }),
        "400": { description: "BAD_REQUEST または VALIDATION_ERROR" },
        "401": selfAuth.responses["401"],
        "403": { description: "FORBIDDEN — サービス用トークン、またはオリジン不正" },
      },
    },
  },
  "/api/users/me/tokens/{tokenId}": {
    delete: {
      tags: ["ユーザー API"],
      summary: "自分のリフレッシュトークンを 1 件失効",
      description:
        "本人のみ。CSRF。tokenId は UUID。他ユーザーの ID や不明な ID は 404。成功は本文なし。BFF セッションは別に失効する。",
      security: bearer,
      parameters: [
        {
          name: "tokenId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "204": { description: "失効成功" },
        "400": { description: "BAD_REQUEST — UUID ではない" },
        "401": selfAuth.responses["401"],
        "403": { description: "FORBIDDEN — サービス用トークン、またはオリジン不正" },
        "404": { description: "NOT_FOUND" },
      },
    },
  },
  "/api/users/{id}/owned-services": {
    get: {
      tags: ["ユーザー API (管理者)"],
      summary: "ユーザーが所有するサービス一覧",
      description: "管理者専用。client_secret は返さない。",
      security: bearer,
      parameters: [userId],
      responses: {
        "200": dataResponse("所有サービス", {
          type: "array",
          items: {
            type: "object",
            required: ["id", "name", "client_id", "allowed_scopes", "created_at"],
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              client_id: { type: "string" },
              allowed_scopes: { type: "string", description: "保存されているスコープ文字列。" },
              created_at: { type: "string" },
            },
          },
        }),
        "400": { description: "BAD_REQUEST — id が UUID ではない" },
        "401": adminAuth.responses["401"],
        "403": adminAuth.responses["403"],
        "404": { description: "NOT_FOUND — ユーザー未存在" },
      },
    },
  },
  "/api/users/{id}/login-stats": {
    get: {
      tags: ["ユーザー API (管理者)"],
      summary: "ユーザーのプロバイダー別ログイン統計",
      description:
        "管理者専用。days 省略時 30、1〜365。0 件のプロバイダーは含まない。不正 days は BAD_REQUEST で、message は文字列。",
      security: bearer,
      parameters: [userId, daysQuery],
      responses: {
        "200": dataResponse(
          "プロバイダー別件数",
          { type: "array", items: providerStat },
          { days: { type: "integer" } },
        ),
        "400": { description: "BAD_REQUEST — id または days が不正" },
        "401": adminAuth.responses["401"],
        "403": adminAuth.responses["403"],
        "404": { description: "NOT_FOUND" },
      },
    },
  },
  "/api/users/{id}/login-trends": {
    get: {
      tags: ["ユーザー API (管理者)"],
      summary: "ユーザーの日別ログイントレンド",
      description: "管理者専用。days は login-stats と同じ。0 件の日は補完しない。",
      security: bearer,
      parameters: [userId, daysQuery],
      responses: {
        "200": dataResponse(
          "日別件数",
          { type: "array", items: dailyStat },
          {
            days: { type: "integer" },
          },
        ),
        "400": { description: "BAD_REQUEST — id または days が不正" },
        "401": adminAuth.responses["401"],
        "403": adminAuth.responses["403"],
        "404": { description: "NOT_FOUND" },
      },
    },
  },
  "/api/users/{id}/ban": {
    patch: {
      tags: ["ユーザー API (管理者)"],
      summary: "ユーザーを BAN",
      description:
        "管理者専用。CSRF。自分自身と admin ロールは 403。既に BAN 済みは 409。成功時はトークン失効を伴い、監査ログ user.ban を残す。本文は不要。",
      security: bearer,
      parameters: [userId],
      responses: {
        "200": { description: "BAN 後の管理者向けユーザー要約" },
        "400": { description: "BAD_REQUEST — id が UUID ではない" },
        "401": adminAuth.responses["401"],
        "403": {
          description: "FORBIDDEN — 自分自身、admin ユーザー、権限なし、またはオリジン不正",
        },
        "404": { description: "NOT_FOUND" },
        "409": { description: "CONFLICT — 既に BAN 済み" },
        "500": { description: "INTERNAL_ERROR" },
      },
    },
    delete: {
      tags: ["ユーザー API (管理者)"],
      summary: "ユーザーの BAN を解除",
      description: "管理者専用。CSRF。BAN されていなければ 409。監査ログ user.unban。",
      security: bearer,
      parameters: [userId],
      responses: {
        "200": { description: "解除後の管理者向けユーザー要約" },
        "400": { description: "BAD_REQUEST — id が UUID ではない" },
        "401": adminAuth.responses["401"],
        "403": { description: "FORBIDDEN — 管理者権限なし、またはオリジン不正" },
        "404": { description: "NOT_FOUND" },
        "409": { description: "CONFLICT — BAN されていない" },
      },
    },
  },
  "/api/users/{id}/tokens": {
    get: {
      tags: ["ユーザー API (管理者)"],
      summary: "ユーザーのアクティブリフレッシュトークン一覧",
      description: "管理者専用。本人の GET /api/users/me/tokens と同じセッション配列。",
      security: bearer,
      parameters: [userId],
      responses: {
        "200": { description: "アクティブセッション一覧" },
        "400": { description: "BAD_REQUEST — id が UUID ではない" },
        "401": adminAuth.responses["401"],
        "403": adminAuth.responses["403"],
        "404": { description: "NOT_FOUND" },
      },
    },
    delete: {
      tags: ["ユーザー API (管理者)"],
      summary: "ユーザーの全トークンを失効",
      description:
        "管理者専用。CSRF。リフレッシュトークン、MCP セッション、BFF セッションを失効する。成功は本文なし。",
      security: bearer,
      parameters: [userId],
      responses: {
        "204": { description: "失効成功" },
        "400": { description: "BAD_REQUEST — id が UUID ではない" },
        "401": adminAuth.responses["401"],
        "403": { description: "FORBIDDEN — 管理者権限なし、またはオリジン不正" },
        "404": { description: "NOT_FOUND" },
      },
    },
  },
  "/api/users/{id}/tokens/{tokenId}": {
    delete: {
      tags: ["ユーザー API (管理者)"],
      summary: "ユーザーのリフレッシュトークンを 1 件失効",
      description:
        "管理者専用。CSRF。tokenId は UUID。対象ユーザーのトークンでなければ 404。成功は本文なし。",
      security: bearer,
      parameters: [
        userId,
        {
          name: "tokenId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "204": { description: "失効成功" },
        "400": { description: "BAD_REQUEST — id または tokenId が UUID ではない" },
        "401": adminAuth.responses["401"],
        "403": { description: "FORBIDDEN — 管理者権限なし、またはオリジン不正" },
        "404": { description: "NOT_FOUND" },
      },
    },
  },
  "/api/users/{id}/bff-sessions": {
    get: {
      tags: ["ユーザー API (管理者)"],
      summary: "ユーザーの BFF セッション一覧",
      description: "管理者専用。has_device_key と device_bound_at を含み、公開鍵 JWK は返さない。",
      security: bearer,
      parameters: [userId],
      responses: {
        "200": { description: "BFF セッション一覧" },
        "400": { description: "BAD_REQUEST — id が UUID ではない" },
        "401": adminAuth.responses["401"],
        "403": adminAuth.responses["403"],
        "404": { description: "NOT_FOUND" },
      },
    },
  },
  "/api/users/{id}/bff-sessions/{sessionId}": {
    delete: {
      tags: ["ユーザー API (管理者)"],
      summary: "ユーザーの BFF セッションを 1 件失効",
      description:
        "管理者専用。CSRF。revoked_reason は admin_action:<adminUserId>。監査ログ user.bff_session_revoked。リフレッシュトークンは残る。成功は本文なし。",
      security: bearer,
      parameters: [
        userId,
        {
          name: "sessionId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "204": { description: "失効成功" },
        "400": { description: "BAD_REQUEST — id または sessionId が UUID ではない" },
        "401": adminAuth.responses["401"],
        "403": { description: "FORBIDDEN — 管理者権限なし、またはオリジン不正" },
        "404": { description: "NOT_FOUND" },
      },
    },
  },
  "/auth/dbsc/bind": {
    post: {
      tags: ["DBSC"],
      summary: "DBSC 端末公開鍵のバインド",
      description:
        "BFF 専用。serviceBindingMiddleware（X-Internal-Secret または Basic）。X-BFF-Origin が session.bff_origin と一致する必要がある。有効セッションだけを対象にし、既にバインド済みは 409。公開鍵は ES256 / P-256 の x と y のみ。",
      parameters: [bffOrigin],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["session_id", "public_jwk"],
              properties: {
                session_id: { type: "string", minLength: 1, maxLength: 128 },
                public_jwk: {
                  type: "object",
                  additionalProperties: false,
                  required: ["kty", "crv", "x", "y"],
                  properties: {
                    kty: { type: "string", enum: ["EC"] },
                    crv: { type: "string", enum: ["P-256"] },
                    x: { type: "string", minLength: 1 },
                    y: { type: "string", minLength: 1 },
                  },
                },
              },
            },
          },
        },
      },
      responses: {
        "200": dataResponse("バインド結果", {
          type: "object",
          required: ["session_id", "bound_at"],
          properties: {
            session_id: { type: "string" },
            bound_at: { type: "integer", description: "UNIX 秒" },
          },
        }),
        "400": { description: "BAD_REQUEST または VALIDATION_ERROR" },
        "403": { description: "FORBIDDEN — サービスバインディング拒否、または Caller mismatch" },
        "404": { description: "INVALID_SESSION — セッションが無い、期限切れ、または失効" },
        "409": { description: "ALREADY_BOUND" },
        "500": { description: "INTERNAL_ERROR" },
      },
    },
  },
  "/auth/dbsc/challenge": {
    post: {
      tags: ["DBSC"],
      summary: "DBSC リフレッシュ用 nonce の発行",
      description:
        "BFF 専用。認証は bind と同じ。端末バインド済みの有効セッションだけ。TTL は 60 秒。未バインド・期限切れ・不存在は区別せず 404。",
      parameters: [bffOrigin],
      requestBody: {
        required: true,
        content: { "application/json": { schema: dbscSession } },
      },
      responses: {
        "200": dataResponse("nonce", {
          type: "object",
          required: ["nonce", "expires_at"],
          properties: {
            nonce: { type: "string" },
            expires_at: { type: "integer", description: "UNIX 秒。発行から 60 秒。" },
          },
        }),
        "400": { description: "BAD_REQUEST または VALIDATION_ERROR" },
        "403": { description: "FORBIDDEN — サービスバインディング拒否、または Caller mismatch" },
        "404": { description: "INVALID_SESSION" },
        "500": { description: "INTERNAL_ERROR" },
      },
    },
  },
  "/auth/dbsc/verify": {
    post: {
      tags: ["DBSC"],
      summary: "DBSC proof JWT の検証",
      description:
        "BFF 専用。認証は bind と同じ。登録済み公開鍵で ES256 を検証し、aud は session.bff_origin、jti を nonce として一度だけ消費する。失敗理由は INVALID_PROOF にまとめる。本文の追加 audience は使わない。",
      parameters: [bffOrigin],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["session_id", "jwt"],
              properties: {
                session_id: { type: "string", minLength: 1, maxLength: 128 },
                jwt: { type: "string", minLength: 1, maxLength: 8192 },
              },
            },
          },
        },
      },
      responses: {
        "200": dataResponse("検証結果", {
          type: "object",
          required: ["session_id", "verified_at"],
          properties: {
            session_id: { type: "string" },
            verified_at: { type: "integer", description: "UNIX 秒" },
          },
        }),
        "400": { description: "VALIDATION_ERROR、または INVALID_PROOF" },
        "403": { description: "FORBIDDEN — サービスバインディング拒否、または Caller mismatch" },
      },
    },
  },
  "/auth/dbsc/status": {
    post: {
      tags: ["DBSC"],
      summary: "BFF セッションの端末バインド状態",
      description:
        "BFF 専用。認証は bind と同じ。不存在・失効・期限切れ・X-BFF-Origin 不一致は 403 にせず、device_bound=false かつ device_bound_at=null で 200 を返す。",
      parameters: [bffOrigin],
      requestBody: {
        required: true,
        content: { "application/json": { schema: dbscSession } },
      },
      responses: {
        "200": dataResponse("バインド状態", {
          type: "object",
          required: ["device_bound", "device_bound_at"],
          properties: {
            device_bound: { type: "boolean" },
            device_bound_at: {
              type: ["integer", "null"],
              description: "UNIX 秒。未バインドは null。",
            },
          },
        }),
        "400": { description: "BAD_REQUEST または VALIDATION_ERROR" },
        "403": { description: "FORBIDDEN — サービスバインディング拒否" },
      },
    },
  },
  "/auth/passkey/start": {
    get: {
      tags: ["パスキー"],
      summary: "ネイティブパスキーログインの開始",
      description:
        "PASSKEY_LOGIN_ENABLED が文字列 true のときだけ継続できる。登録済み callback、state、サービス PKCE を再検証し、短命の暗号 cookie を置いて /auth/passkey へ 303 する。proof は消費しない。失敗は LOGIN_UNAVAILABLE。",
      responses: {
        "303": { description: "/auth/passkey へリダイレクト" },
        "400": { description: "LOGIN_UNAVAILABLE" },
      },
    },
  },
  "/auth/passkey": {
    get: {
      tags: ["パスキー"],
      summary: "パスキーログイン UI",
      description:
        "継続 cookie が有効なブラウザ向け HTML。自動認証はしない。失敗は LOGIN_UNAVAILABLE。",
      responses: {
        "200": { description: "HTML" },
        "400": { description: "LOGIN_UNAVAILABLE" },
      },
    },
  },
  "/auth/passkey/options": {
    post: {
      tags: ["パスキー"],
      summary: "discoverable パスキー challenge",
      description:
        "JSON。confirm=true と csrf だけ。exact Origin と継続 cookie。本文上限 32KiB。アカウント検索をしない。成功は WebAuthn options のみ。",
      responses: {
        "200": { description: "{ options }。所有者・メール・authority は含めない。" },
        "400": { description: "LOGIN_UNAVAILABLE" },
        "403": { description: "LOGIN_UNAVAILABLE — 継続状態または CSRF が一致しない" },
        "413": { description: "LOGIN_UNAVAILABLE — 本文が 32KiB を超える" },
      },
    },
  },
  "/auth/passkey/verify": {
    post: {
      tags: ["パスキー"],
      summary: "パスキー署名の検証",
      description:
        "application/x-www-form-urlencoded の csrf と credential だけ。本文上限 32KiB。UP/UV、userHandle、RP、origin、challenge、登録世代を検証し、通常の認可コード発行へ合流する。失敗は汎用 LOGIN_UNAVAILABLE。",
      responses: {
        "302": { description: "登録済み callback へ認可コード付きでリダイレクト" },
        "400": { description: "LOGIN_UNAVAILABLE" },
        "403": { description: "LOGIN_UNAVAILABLE" },
        "413": { description: "LOGIN_UNAVAILABLE" },
      },
    },
  },
  "/auth/email/signup/start": {
    get: {
      tags: ["メール登録"],
      summary: "メール登録フローの開始",
      description:
        "EMAIL_PASSKEY_SIGNUP_ENABLED を含む必須設定が揃ったときだけ継続できる。DB 書き込みと送信はしない。失敗は SIGNUP_UNAVAILABLE。",
      responses: {
        "303": { description: "/auth/email/signup へリダイレクト" },
        "400": { description: "SIGNUP_UNAVAILABLE" },
      },
    },
  },
  "/auth/email/signup": {
    get: {
      tags: ["メール登録"],
      summary: "メール入力 UI",
      description: "継続 cookie がある場合の HTML。明示操作まで送信しない。",
      responses: {
        "200": { description: "HTML" },
        "400": { description: "SIGNUP_UNAVAILABLE" },
      },
    },
  },
  "/auth/email/start": {
    post: {
      tags: ["メール登録"],
      summary: "確認メールの送信要求",
      description:
        "JSON の csrf、confirm=true、email。既存・抑止・新規・形式外は同じ 202。トークンは応答に含めない。設定や実行基盤が無い場合は SIGNUP_UNAVAILABLE。",
      responses: {
        "202": {
          description:
            '{ status: "accepted", message: "If eligible, follow the email in this browser" }',
        },
        "400": { description: "SIGNUP_UNAVAILABLE" },
        "403": { description: "SIGNUP_UNAVAILABLE" },
        "413": { description: "SIGNUP_UNAVAILABLE" },
        "503": { description: "SIGNUP_UNAVAILABLE — waitUntil が無い" },
      },
    },
  },
  "/auth/email/verify": {
    get: {
      tags: ["メール登録"],
      summary: "メール確認ページ",
      description: "GET は proof を読まず消費しない。失敗時も確認ページの HTML を返すことがある。",
      responses: {
        "200": { description: "HTML" },
        "400": { description: "確認ページ、または SIGNUP_UNAVAILABLE" },
      },
    },
    post: {
      tags: ["メール登録"],
      summary: "メール proof の消費",
      description:
        "同じブラウザの継続状態に束縛して proof を一度だけ消費する。成功は { next: /auth/email/register }。",
      responses: {
        "200": { description: '{ next: "/auth/email/register" }' },
        "400": { description: "SIGNUP_UNAVAILABLE" },
        "403": { description: "SIGNUP_UNAVAILABLE" },
        "413": { description: "SIGNUP_UNAVAILABLE" },
      },
    },
  },
  "/auth/email/register": {
    get: {
      tags: ["メール登録"],
      summary: "パスキー登録 UI",
      description: "確認済みなら登録 UI、そうでなければ署名ログイン案内。この GET では認証しない。",
      responses: {
        "200": { description: "HTML" },
        "400": { description: "継続状態が無い場合の案内 HTML" },
      },
    },
  },
  "/auth/email/registration/options": {
    post: {
      tags: ["メール登録"],
      summary: "新規登録用パスキー options",
      description:
        "確認済み authority と表示名が必要。成功は WebAuthn options。resident key と UV を要求する。",
      responses: {
        "200": { description: "{ options }" },
        "400": { description: "SIGNUP_UNAVAILABLE" },
        "403": { description: "SIGNUP_UNAVAILABLE" },
        "413": { description: "SIGNUP_UNAVAILABLE" },
      },
    },
  },
  "/auth/email/registration/complete": {
    post: {
      tags: ["メール登録"],
      summary: "新規アカウントの作成",
      description:
        "form の csrf と credential。アカウント作成後も認可コードは出さず、新しいパスキーログインへ 303 する。",
      responses: {
        "303": { description: "/auth/passkey へリダイレクト" },
        "400": { description: "SIGNUP_UNAVAILABLE、または復旧案内 HTML" },
        "403": { description: "SIGNUP_UNAVAILABLE" },
        "413": { description: "SIGNUP_UNAVAILABLE" },
      },
    },
  },
  "/auth/email/login": {
    post: {
      tags: ["メール登録"],
      summary: "結果不明時の署名ログイン再開",
      description:
        "メールアドレスだけではログインしない。明示確認のあと新しいパスキーログインへ 303 する。",
      responses: {
        "303": { description: "/auth/passkey へリダイレクト" },
        "400": { description: "SIGNUP_UNAVAILABLE" },
        "403": { description: "SIGNUP_UNAVAILABLE" },
        "413": { description: "SIGNUP_UNAVAILABLE" },
      },
    },
  },
  "/docs": {
    get: {
      tags: ["ドキュメント"],
      summary: "内部 API の Scalar UI",
      description:
        "GET /docs/openapi.json を表示する HTML。仕様そのものは OpenAPI 応答が一次情報。",
      responses: { "200": { description: "text/html" } },
    },
  },
  "/docs/openapi.json": {
    get: {
      tags: ["ドキュメント"],
      summary: "内部 OpenAPI 文書",
      description: "この内部仕様オブジェクトの JSON。",
      responses: { "200": { description: "application/json" } },
    },
  },
  "/docs/openapi.md": {
    get: {
      tags: ["ドキュメント"],
      summary: "内部 OpenAPI の Markdown",
      description: "内部仕様から生成した Markdown。",
      responses: { "200": { description: "text/markdown" } },
    },
  },
  "/docs/external": {
    get: {
      tags: ["ドキュメント"],
      summary: "外部 API の Scalar UI",
      responses: { "200": { description: "text/html" } },
    },
  },
  "/docs/external/openapi.json": {
    get: {
      tags: ["ドキュメント"],
      summary: "外部 OpenAPI 文書",
      responses: { "200": { description: "application/json" } },
    },
  },
  "/docs/external.md": {
    get: {
      tags: ["ドキュメント"],
      summary: "外部 OpenAPI の Markdown",
      responses: { "200": { description: "text/markdown" } },
    },
  },
};

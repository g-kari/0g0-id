// IdP 内部向け全API OpenAPI 仕様
// API 変更時はこのファイルの paths / components.schemas を更新すること

export const INTERNAL_OPENAPI = {
  openapi: "3.1.0",
  info: {
    title: "0g0 ID — IdP 内部 API",
    version: "1.0.0",
    description:
      "統合ID基盤（IdP）の内部APIドキュメント。IdPサービス開発者・管理者向け。\n\nベースURL: `https://id.0g0.xyz`",
  },
  servers: [{ url: "https://id.0g0.xyz", description: "本番環境" }],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "アクセストークン（ES256 JWT、有効期限15分）",
      },
      BasicAuth: {
        type: "http",
        scheme: "basic",
        description: "サービス認証: `client_id:client_secret` をBase64エンコード",
      },
    },
    schemas: {
      Error: {
        type: "object",
        properties: {
          error: {
            type: "object",
            properties: {
              code: { type: "string", example: "UNAUTHORIZED" },
              message: { type: "string", example: "Invalid credentials" },
            },
            required: ["code", "message"],
          },
        },
      },
      LoginEvent: {
        type: "object",
        properties: {
          id: { type: "string" },
          user_id: { type: "string" },
          provider: { type: "string", enum: ["google", "line", "twitch", "github", "x"] },
          ip_address: { type: "string", nullable: true },
          user_agent: { type: "string", nullable: true },
          created_at: { type: "string", format: "date-time" },
        },
        required: ["id", "user_id", "provider", "created_at"],
      },
      User: {
        type: "object",
        properties: {
          id: { type: "string" },
          email: { type: "string" },
          name: { type: "string" },
          picture: { type: "string", nullable: true },
          role: { type: "string", enum: ["user", "admin"] },
          created_at: { type: "string", format: "date-time" },
        },
      },
      Service: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          client_id: { type: "string" },
          allowed_scopes: {
            type: "array",
            items: { type: "string" },
          },
          created_at: { type: "string", format: "date-time" },
        },
      },
      TokenPair: {
        type: "object",
        properties: {
          access_token: { type: "string" },
          refresh_token: { type: "string" },
          session_id: {
            type: "string",
            format: "uuid",
            description: "BFFセッションID（BFFフロー時のみ返却。リモート失効用）",
          },
          token_type: { type: "string", example: "Bearer" },
          expires_in: { type: "integer", example: 900 },
          user: { $ref: "#/components/schemas/User" },
        },
      },
    },
  },
  paths: {
    "/auth/login": {
      get: {
        tags: ["認証フロー"],
        summary: "ログイン開始",
        description: "BFFからのリダイレクトを受け取り、Googleの認可画面へリダイレクトする。",
        parameters: [
          {
            name: "redirect_to",
            in: "query",
            required: true,
            schema: { type: "string" },
            description: "コールバック先URL（user/adminオリジンのみ許可）",
          },
          {
            name: "state",
            in: "query",
            required: true,
            schema: { type: "string" },
            description: "CSRF対策用ランダム値（BFF生成）",
          },
        ],
        responses: {
          "302": { description: "Googleの認可画面へリダイレクト" },
        },
      },
    },
    "/auth/callback": {
      get: {
        tags: ["認証フロー"],
        summary: "Google OAuthコールバック",
        description:
          "Googleからのコールバック。ユーザーを作成/更新し、ワンタイム認可コード（60秒有効）を発行してBFFへリダイレクト。",
        responses: {
          "302": { description: "BFFへリダイレクト（?code=...）" },
        },
      },
    },
    "/auth/exchange": {
      post: {
        tags: ["認証フロー"],
        summary: "コードをトークンに交換",
        description:
          "ワンタイムコードをアクセストークン（15分）＋リフレッシュトークン（30日）に交換する。Service Bindingsによるサーバー間通信専用。BFFフロー時は session_id（bff_sessions 行ID）を同梱し、Cookie に埋め込むことでリモート失効可能にする。",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  code: { type: "string", description: "ワンタイム認可コード（必須）" },
                },
                required: ["code"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "トークン発行成功",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { data: { $ref: "#/components/schemas/TokenPair" } },
                },
              },
            },
          },
          "400": { description: "BAD_REQUEST — コード不正" },
          "401": { description: "UNAUTHORIZED — コード無効/期限切れ" },
        },
      },
    },
    "/auth/refresh": {
      post: {
        tags: ["認証フロー"],
        summary: "アクセストークン更新",
        description:
          "リフレッシュトークンを使って新しいアクセストークンを発行する（トークンローテーション）。再使用検出時はファミリー全体を失効させる。",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  refresh_token: { type: "string", description: "有効なリフレッシュトークン" },
                },
                required: ["refresh_token"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "新しいトークンペア",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { data: { $ref: "#/components/schemas/TokenPair" } },
                },
              },
            },
          },
          "401": { description: "UNAUTHORIZED — トークン無効/再使用検出" },
        },
      },
    },
    "/auth/logout": {
      post: {
        tags: ["認証フロー"],
        summary: "ログアウト",
        description:
          "リフレッシュトークンファミリー全体を失効させる。session_id が指定された場合は bff_sessions の該当行も失効させる。",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  refresh_token: {
                    type: "string",
                    description: "失効させるトークン（省略時は何もしない）",
                  },
                  session_id: {
                    type: "string",
                    format: "uuid",
                    description:
                      "BFFセッションID。Cookie に埋め込まれている session_id を渡すことで bff_sessions 側も失効させる。",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "ログアウト成功" },
        },
      },
    },
    "/api/users/me": {
      get: {
        tags: ["ユーザー API"],
        summary: "自身のプロフィール取得",
        description: "認証済みユーザー自身のプロフィール情報を返す。",
        security: [{ BearerAuth: [] }],
        responses: {
          "200": {
            description: "ユーザー情報",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { data: { $ref: "#/components/schemas/User" } },
                },
              },
            },
          },
          "401": { description: "UNAUTHORIZED" },
        },
      },
      patch: {
        tags: ["ユーザー API"],
        summary: "プロフィール更新",
        description:
          "ユーザープロフィールを更新する（name必須、picture/phone/address任意）。Origin/RefererヘッダーによるCSRF検証あり。",
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string", description: "新しい表示名（空白のみ不可）" },
                  picture: {
                    type: "string",
                    nullable: true,
                    description: "プロフィール画像URL（省略時は変更なし）",
                  },
                  phone: {
                    type: "string",
                    nullable: true,
                    description: "電話番号（省略時は変更なし、nullで削除）",
                  },
                  address: {
                    type: "string",
                    nullable: true,
                    description: "住所（省略時は変更なし、nullで削除）",
                  },
                },
                required: ["name"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "更新成功",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { data: { $ref: "#/components/schemas/User" } },
                },
              },
            },
          },
          "400": { description: "BAD_REQUEST — nameが空" },
          "401": { description: "UNAUTHORIZED" },
          "403": { description: "FORBIDDEN — オリジン不正" },
        },
      },
    },
    "/api/users": {
      get: {
        tags: ["ユーザー API (管理者)"],
        summary: "ユーザー一覧取得",
        description: "ユーザー一覧を返す（ページネーション対応）。管理者専用。",
        security: [{ BearerAuth: [] }],
        parameters: [
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", default: 50, maximum: 100, minimum: 1 },
            description: "1ページの件数",
          },
          {
            name: "offset",
            in: "query",
            schema: { type: "integer", default: 0, minimum: 0 },
            description: "取得開始位置",
          },
          {
            name: "email",
            in: "query",
            schema: { type: "string" },
            description: "メールアドレスで部分一致フィルタリング",
          },
          {
            name: "role",
            in: "query",
            schema: { type: "string", enum: ["user", "admin"] },
            description: "ロールで絞り込み",
          },
          {
            name: "name",
            in: "query",
            schema: { type: "string" },
            description: "表示名で部分一致フィルタリング",
          },
        ],
        responses: {
          "200": {
            description: "ユーザー一覧",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: { type: "array", items: { $ref: "#/components/schemas/User" } },
                    total: { type: "integer" },
                  },
                },
              },
            },
          },
          "401": { description: "UNAUTHORIZED" },
          "403": { description: "FORBIDDEN — 管理者権限なし" },
        },
      },
    },
    "/api/users/me/login-history": {
      get: {
        tags: ["ユーザー API"],
        summary: "自分のログイン履歴取得",
        description: "認証済みユーザー自身のログイン履歴を返す（ページネーション対応）。",
        security: [{ BearerAuth: [] }],
        parameters: [
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", default: 20, maximum: 100, minimum: 1 },
            description: "1ページの件数（デフォルト20、最大100）",
          },
          {
            name: "offset",
            in: "query",
            schema: { type: "integer", default: 0, minimum: 0 },
            description: "取得開始位置",
          },
        ],
        responses: {
          "200": {
            description: "ログイン履歴",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: { type: "array", items: { $ref: "#/components/schemas/LoginEvent" } },
                    total: { type: "integer", description: "総件数" },
                  },
                },
              },
            },
          },
          "401": { description: "UNAUTHORIZED" },
        },
      },
    },
    "/api/users/me/connections": {
      get: {
        tags: ["ユーザー API"],
        summary: "連携サービス一覧取得",
        description: "ユーザーがアクティブなリフレッシュトークンを持つ連携サービス一覧を返す。",
        security: [{ BearerAuth: [] }],
        responses: {
          "200": {
            description: "連携サービス一覧",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          service_id: { type: "string" },
                          service_name: { type: "string" },
                          client_id: { type: "string" },
                          first_authorized_at: { type: "string", format: "date-time" },
                          last_authorized_at: { type: "string", format: "date-time" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/users/me/connections/{serviceId}": {
      delete: {
        tags: ["ユーザー API"],
        summary: "サービス連携解除",
        description:
          "指定サービスへの連携を解除する（全リフレッシュトークンを失効）。Origin/RefererヘッダーによるCSRF検証あり。",
        security: [{ BearerAuth: [] }],
        parameters: [{ name: "serviceId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "204": { description: "連携解除成功" },
          "401": { description: "UNAUTHORIZED" },
          "403": { description: "FORBIDDEN — オリジン不正" },
          "404": { description: "NOT_FOUND — 連携未存在" },
        },
      },
    },
    "/api/users/me/providers": {
      get: {
        tags: ["ユーザー API"],
        summary: "連携済みSNSプロバイダー一覧取得",
        description: "ユーザーに連携済み・未連携のSNSプロバイダー一覧を返す。",
        security: [{ BearerAuth: [] }],
        responses: {
          "200": {
            description: "プロバイダー一覧",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          provider: {
                            type: "string",
                            enum: ["google", "line", "twitch", "github", "x"],
                          },
                          connected: { type: "boolean" },
                        },
                        required: ["provider", "connected"],
                      },
                    },
                  },
                },
              },
            },
          },
          "401": { description: "UNAUTHORIZED" },
        },
      },
    },
    "/api/users/me/providers/{provider}": {
      delete: {
        tags: ["ユーザー API"],
        summary: "SNSプロバイダー連携解除",
        description:
          "指定SNSプロバイダーの連携を解除する。最後の連携プロバイダーは解除不可。Origin/RefererヘッダーによるCSRF検証あり。",
        security: [{ BearerAuth: [] }],
        parameters: [
          {
            name: "provider",
            in: "path",
            required: true,
            schema: { type: "string", enum: ["google", "line", "twitch", "github", "x"] },
            description: "SNSプロバイダー名",
          },
        ],
        responses: {
          "204": { description: "連携解除成功" },
          "400": { description: "BAD_REQUEST — 不正なプロバイダー名" },
          "401": { description: "UNAUTHORIZED" },
          "403": { description: "FORBIDDEN — オリジン不正" },
          "404": { description: "NOT_FOUND — プロバイダー未連携" },
          "409": { description: "CONFLICT — 最後のプロバイダーは解除不可" },
        },
      },
    },
    "/api/users/{id}/role": {
      patch: {
        tags: ["ユーザー API (管理者)"],
        summary: "ユーザーロール変更",
        description:
          "指定ユーザーのロールを変更する（管理者専用）。変更後は既存トークンを即時失効。自分自身のロール変更は不可。",
        security: [{ BearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  role: { type: "string", enum: ["user", "admin"], description: "新しいロール" },
                },
                required: ["role"],
              },
            },
          },
        },
        responses: {
          "200": { description: "ロール変更成功" },
          "400": { description: "BAD_REQUEST — 不正なロール値" },
          "401": { description: "UNAUTHORIZED" },
          "403": { description: "FORBIDDEN — 管理者権限なし、または自分自身のロール変更" },
          "404": { description: "NOT_FOUND — ユーザー未存在" },
        },
      },
    },
    "/api/users/{id}/services": {
      get: {
        tags: ["ユーザー API (管理者)"],
        summary: "ユーザーの認可済みサービス一覧取得",
        description:
          "指定ユーザーが現在アクティブなリフレッシュトークンを保有するサービス一覧を返す（管理者専用）。`GET /api/services/{id}/users` の逆方向エンドポイント。",
        security: [{ BearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "ユーザーID",
          },
        ],
        responses: {
          "200": {
            description: "認可済みサービス一覧",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          service_id: { type: "string" },
                          service_name: { type: "string" },
                          client_id: { type: "string" },
                          first_authorized_at: { type: "string", format: "date-time" },
                          last_authorized_at: { type: "string", format: "date-time" },
                        },
                        required: [
                          "service_id",
                          "service_name",
                          "client_id",
                          "first_authorized_at",
                          "last_authorized_at",
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
          "401": { description: "UNAUTHORIZED" },
          "403": { description: "FORBIDDEN — 管理者権限なし" },
          "404": { description: "NOT_FOUND — ユーザー未存在" },
        },
      },
    },
    "/api/users/{id}/login-history": {
      get: {
        tags: ["ユーザー API (管理者)"],
        summary: "ユーザーのログイン履歴取得",
        description: "指定ユーザーのログイン履歴を返す（管理者専用、ページネーション対応）。",
        security: [{ BearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "ユーザーID",
          },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", default: 20, maximum: 100, minimum: 1 },
            description: "1ページの件数（デフォルト20、最大100）",
          },
          {
            name: "offset",
            in: "query",
            schema: { type: "integer", default: 0, minimum: 0 },
            description: "取得開始位置",
          },
        ],
        responses: {
          "200": {
            description: "ログイン履歴",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: { type: "array", items: { $ref: "#/components/schemas/LoginEvent" } },
                    total: { type: "integer", description: "総件数" },
                  },
                },
              },
            },
          },
          "401": { description: "UNAUTHORIZED" },
          "403": { description: "FORBIDDEN — 管理者権限なし" },
          "404": { description: "NOT_FOUND — ユーザー未存在" },
        },
      },
    },
    "/api/users/{id}/providers": {
      get: {
        tags: ["ユーザー API (管理者)"],
        summary: "ユーザーのSNSプロバイダー連携状態取得",
        description: "指定ユーザーの連携済み・未連携のSNSプロバイダー一覧を返す（管理者専用）。",
        security: [{ BearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "ユーザーID",
          },
        ],
        responses: {
          "200": {
            description: "プロバイダー一覧",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          provider: {
                            type: "string",
                            enum: ["google", "line", "twitch", "github", "x"],
                          },
                          connected: { type: "boolean" },
                        },
                        required: ["provider", "connected"],
                      },
                    },
                  },
                },
              },
            },
          },
          "401": { description: "UNAUTHORIZED" },
          "403": { description: "FORBIDDEN — 管理者権限なし" },
          "404": { description: "NOT_FOUND — ユーザー未存在" },
        },
      },
    },
    "/api/users/{id}": {
      get: {
        tags: ["ユーザー API (管理者)"],
        summary: "ユーザー詳細取得",
        description:
          "指定ユーザーの詳細情報を返す（管理者専用）。phone / address など内部フィールドも含む。",
        security: [{ BearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "ユーザー詳細",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      allOf: [
                        { $ref: "#/components/schemas/User" },
                        {
                          type: "object",
                          properties: {
                            phone: { type: "string", nullable: true },
                            address: { type: "string", nullable: true },
                            updated_at: { type: "string", format: "date-time" },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
          "401": { description: "UNAUTHORIZED" },
          "403": { description: "FORBIDDEN — 管理者権限なし" },
          "404": { description: "NOT_FOUND — ユーザー未存在" },
        },
      },
      delete: {
        tags: ["ユーザー API (管理者)"],
        summary: "ユーザー削除",
        description:
          "指定ユーザーを削除する（管理者専用）。自分自身の削除は不可。サービス所有者は所有権移譲後でないと削除不可。",
        security: [{ BearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "204": { description: "削除成功" },
          "401": { description: "UNAUTHORIZED" },
          "403": { description: "FORBIDDEN — 管理者権限なし、または自分自身の削除" },
          "404": { description: "NOT_FOUND — ユーザー未存在" },
          "409": { description: "CONFLICT — サービス所有者は削除不可" },
        },
      },
    },
    "/api/services": {
      get: {
        tags: ["サービス管理 API (管理者)"],
        summary: "登録済みサービス一覧取得",
        security: [{ BearerAuth: [] }],
        responses: {
          "200": {
            description: "サービス一覧",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: { type: "array", items: { $ref: "#/components/schemas/Service" } },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ["サービス管理 API (管理者)"],
        summary: "サービス登録",
        description: "新しいサービスを登録する。`client_secret` は作成時のみ返却（再取得不可）。",
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string", description: "サービス名（必須）" },
                  allowed_scopes: {
                    type: "array",
                    items: { type: "string", enum: ["profile", "email", "phone", "address"] },
                    description: '許可スコープ（省略時: ["profile","email"]）',
                  },
                },
                required: ["name"],
              },
            },
          },
        },
        responses: {
          "201": {
            description: "サービス作成成功（client_secretを含む）",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      allOf: [
                        { $ref: "#/components/schemas/Service" },
                        { type: "object", properties: { client_secret: { type: "string" } } },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/services/{id}": {
      get: {
        tags: ["サービス管理 API (管理者)"],
        summary: "サービス取得",
        description: "指定IDのサービス詳細を返す（管理者専用）。",
        security: [{ BearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "サービス詳細",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { data: { $ref: "#/components/schemas/Service" } },
                },
              },
            },
          },
          "401": { description: "UNAUTHORIZED" },
          "403": { description: "FORBIDDEN — 管理者権限なし" },
          "404": { description: "NOT_FOUND — サービス未存在" },
        },
      },
      patch: {
        tags: ["サービス管理 API (管理者)"],
        summary: "サービス情報更新",
        description:
          "指定サービスの名前・許可スコープを更新する（管理者専用）。name と allowed_scopes の少なくとも一方が必要。Origin/RefererヘッダーによるCSRF検証あり。",
        security: [{ BearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: {
                    type: "string",
                    description: "新しいサービス名（省略時は変更なし、空文字不可）",
                  },
                  allowed_scopes: {
                    type: "array",
                    items: { type: "string", enum: ["profile", "email", "phone", "address"] },
                    description: "新しい許可スコープ（省略時は変更なし、空配列不可）",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "更新成功",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { data: { $ref: "#/components/schemas/Service" } },
                },
              },
            },
          },
          "400": { description: "BAD_REQUEST — 不正なスコープ値または空配列" },
          "401": { description: "UNAUTHORIZED" },
          "403": { description: "FORBIDDEN — 管理者権限なし、またはオリジン不正" },
          "404": { description: "NOT_FOUND — サービス未存在" },
        },
      },
      delete: {
        tags: ["サービス管理 API (管理者)"],
        summary: "サービス削除",
        description:
          "指定サービスを削除する（管理者専用）。Origin/RefererヘッダーによるCSRF検証あり。",
        security: [{ BearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "204": { description: "削除成功" },
          "401": { description: "UNAUTHORIZED" },
          "403": { description: "FORBIDDEN — 管理者権限なし、またはオリジン不正" },
          "404": { description: "NOT_FOUND — サービス未存在" },
        },
      },
    },
    "/api/services/{id}/rotate-secret": {
      post: {
        tags: ["サービス管理 API (管理者)"],
        summary: "クライアントシークレット再発行",
        description:
          "指定サービスのクライアントシークレットを再発行する（管理者専用）。" +
          "旧シークレットは即時無効化される。新しい `client_secret` はこのレスポンスのみで返却（再取得不可）。" +
          "Origin/RefererヘッダーによるCSRF検証あり。",
        security: [{ BearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "再発行成功（新しいclient_secretを含む）",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        client_id: { type: "string" },
                        client_secret: {
                          type: "string",
                          description: "新しいクライアントシークレット（このレスポンスのみ）",
                        },
                        updated_at: { type: "string", format: "date-time" },
                      },
                      required: ["id", "client_id", "client_secret", "updated_at"],
                    },
                  },
                },
              },
            },
          },
          "401": { description: "UNAUTHORIZED" },
          "403": { description: "FORBIDDEN — 管理者権限なし、またはオリジン不正" },
          "404": { description: "NOT_FOUND — サービス未存在" },
        },
      },
    },
    "/api/services/{id}/owner": {
      patch: {
        tags: ["サービス管理 API (管理者)"],
        summary: "サービス所有権移譲",
        description:
          "指定サービスの所有権を別ユーザーに移譲する（管理者専用）。移譲先ユーザーが存在しない場合は 404 を返す。Origin/RefererヘッダーによるCSRF検証あり。",
        security: [{ BearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "サービスID",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  new_owner_user_id: {
                    type: "string",
                    description: "新しいオーナーのユーザーID（必須）",
                  },
                },
                required: ["new_owner_user_id"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "移譲成功",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        name: { type: "string" },
                        client_id: { type: "string" },
                        owner_user_id: { type: "string" },
                        updated_at: { type: "string", format: "date-time" },
                      },
                    },
                  },
                },
              },
            },
          },
          "400": { description: "BAD_REQUEST — new_owner_user_id が未指定" },
          "401": { description: "UNAUTHORIZED" },
          "403": { description: "FORBIDDEN — 管理者権限なし、またはオリジン不正" },
          "404": { description: "NOT_FOUND — サービスまたは移譲先ユーザーが未存在" },
        },
      },
    },
    "/api/services/{id}/users": {
      get: {
        tags: ["サービス管理 API (管理者)"],
        summary: "サービス認可済みユーザー一覧取得",
        description:
          "指定サービスにアクティブなリフレッシュトークンを持つ認可済みユーザー一覧を返す（管理者専用、ページネーション対応）。",
        security: [{ BearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "サービスID",
          },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", default: 50, maximum: 100, minimum: 1 },
            description: "1ページの件数",
          },
          {
            name: "offset",
            in: "query",
            schema: { type: "integer", default: 0, minimum: 0 },
            description: "取得開始位置",
          },
        ],
        responses: {
          "200": {
            description: "認可済みユーザー一覧",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: { type: "array", items: { $ref: "#/components/schemas/User" } },
                    total: { type: "integer", description: "総ユーザー数" },
                  },
                },
              },
            },
          },
          "401": { description: "UNAUTHORIZED" },
          "403": { description: "FORBIDDEN — 管理者権限なし" },
          "404": { description: "NOT_FOUND — サービス未存在" },
        },
      },
    },
    "/api/services/{id}/users/{userId}": {
      delete: {
        tags: ["サービス管理 API (管理者)"],
        summary: "ユーザーのサービスアクセス失効",
        description:
          "指定ユーザーの指定サービスに対するすべてのリフレッシュトークンを失効させる（管理者専用）。ユーザーのサービスアクセスを強制的に取り消す。Origin/RefererヘッダーによるCSRF検証あり。",
        security: [{ BearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "サービスID",
          },
          {
            name: "userId",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "ユーザーID",
          },
        ],
        responses: {
          "204": { description: "アクセス失効成功" },
          "401": { description: "UNAUTHORIZED" },
          "403": { description: "FORBIDDEN — 管理者権限なし、またはオリジン不正" },
          "404": {
            description:
              "NOT_FOUND — サービス未存在、ユーザー未存在、またはユーザーの認可が存在しない",
          },
        },
      },
    },
    "/api/services/{id}/redirect-uris": {
      get: {
        tags: ["サービス管理 API (管理者)"],
        summary: "リダイレクトURI一覧取得",
        security: [{ BearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "URI一覧" },
        },
      },
      post: {
        tags: ["サービス管理 API (管理者)"],
        summary: "リダイレクトURI追加",
        description: "HTTPS必須（localhost例外あり）、fragment禁止、自動正規化。",
        security: [{ BearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { uri: { type: "string", description: "追加するリダイレクトURI" } },
                required: ["uri"],
              },
            },
          },
        },
        responses: {
          "201": { description: "追加成功" },
          "409": { description: "CONFLICT — 重複URI" },
        },
      },
    },
    "/api/services/{id}/redirect-uris/{uriId}": {
      delete: {
        tags: ["サービス管理 API (管理者)"],
        summary: "リダイレクトURI削除",
        description:
          "指定リダイレクトURIを削除する（管理者専用）。Origin/RefererヘッダーによるCSRF検証あり。",
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "uriId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "204": { description: "削除成功" },
          "401": { description: "UNAUTHORIZED" },
          "403": { description: "FORBIDDEN — 管理者権限なし、またはオリジン不正" },
          "404": { description: "NOT_FOUND — サービス未存在" },
        },
      },
    },
    "/api/token/introspect": {
      post: {
        tags: ["トークン"],
        summary: "トークンイントロスペクション",
        description:
          "RFC 7662 準拠のトークン検証エンドポイント。Basic認証（client_id:client_secret）が必要。",
        security: [{ BasicAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  token: { type: "string", description: "検証するリフレッシュトークン" },
                },
                required: ["token"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "イントロスペクション結果",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    active: { type: "boolean" },
                    sub: { type: "string" },
                    exp: { type: "integer" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/.well-known/jwks.json": {
      get: {
        tags: ["公開エンドポイント"],
        summary: "JWK Set取得",
        description: "JWT署名検証用のES256公開鍵（JWK Set）を返す。",
        responses: {
          "200": { description: "JWK Set" },
        },
      },
    },
    "/api/health": {
      get: {
        tags: ["公開エンドポイント"],
        summary: "ヘルスチェック",
        responses: {
          "200": {
            description: "正常",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", example: "ok" },
                    worker: { type: "string", example: "id" },
                    timestamp: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/users/me/tokens": {
      get: {
        tags: ["ユーザー API"],
        summary: "アクティブセッション一覧取得",
        description:
          "認証済みユーザー自身のアクティブなセッション（リフレッシュトークン）一覧を返す。IdPセッションと外部サービストークン両方を含む。",
        security: [{ BearerAuth: [] }],
        responses: {
          "200": {
            description: "アクティブセッション一覧",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string", description: "セッションID" },
                          service_id: {
                            type: "string",
                            nullable: true,
                            description: "外部サービスID（IdPセッションはnull）",
                          },
                          service_name: {
                            type: "string",
                            nullable: true,
                            description: "サービス名（IdPセッションはnull）",
                          },
                          created_at: { type: "string", format: "date-time" },
                          expires_at: { type: "string", format: "date-time" },
                        },
                        required: ["id", "service_id", "service_name", "created_at", "expires_at"],
                      },
                    },
                  },
                },
              },
            },
          },
          "401": { description: "UNAUTHORIZED" },
        },
      },
    },
    "/api/users/me/bff-sessions": {
      get: {
        tags: ["ユーザー API"],
        summary: "自分のBFFセッション一覧取得",
        description:
          "認証済みユーザー自身のアクティブなBFFセッション一覧を返す。DBSC（Device Bound Session Credentials）バインド状態を `has_device_key` / `device_bound_at` で含む。公開鍵 JWK そのものは返さない。",
        security: [{ BearerAuth: [] }],
        responses: {
          "200": {
            description: "BFFセッション一覧",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string", description: "BFFセッションID" },
                          user_id: { type: "string" },
                          created_at: { type: "integer", description: "作成日時（unix秒）" },
                          expires_at: { type: "integer", description: "有効期限（unix秒）" },
                          user_agent: { type: "string", nullable: true },
                          ip: { type: "string", nullable: true },
                          bff_origin: { type: "string", description: "BFFオリジン（user/admin）" },
                          has_device_key: {
                            type: "boolean",
                            description: "DBSC端末鍵がバインド済みかどうか",
                          },
                          device_bound_at: {
                            type: "integer",
                            nullable: true,
                            description: "DBSCバインド日時（unix秒）",
                          },
                        },
                        required: [
                          "id",
                          "user_id",
                          "created_at",
                          "expires_at",
                          "user_agent",
                          "ip",
                          "bff_origin",
                          "has_device_key",
                          "device_bound_at",
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
          "401": { description: "UNAUTHORIZED" },
        },
      },
    },
    "/api/users/me/bff-sessions/{sessionId}": {
      delete: {
        tags: ["ユーザー API"],
        summary: "自BFFセッション失効（self-service）",
        description:
          "認証済みユーザー自身のBFFセッションを1件失効する。DBSC 端末バインド済みセッションも対象。user_id 一致条件により他ユーザーのセッションIDを指定した場合も `NOT_FOUND` に畳み込み、列挙攻撃を防ぐ。refresh_token は別途 `DELETE /api/users/me/tokens/:tokenId` で失効する必要がある。",
        security: [{ BearerAuth: [] }],
        parameters: [
          {
            name: "sessionId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
            description: "失効対象のBFFセッションID",
          },
        ],
        responses: {
          "204": { description: "失効成功（body なし）" },
          "400": { description: "BAD_REQUEST（sessionId が UUID 形式でない）" },
          "401": { description: "UNAUTHORIZED" },
          "403": { description: "FORBIDDEN（CSRF / service token / ban）" },
          "404": { description: "NOT_FOUND（他ユーザーセッション・存在しないID・既失効を含む）" },
        },
      },
    },
    "/api/external/users": {
      get: {
        tags: ["外部サービス向け API"],
        summary: "認可済みユーザー一覧取得",
        description: "このサービスを認可済みのユーザー一覧を返す（ページネーション対応）。",
        security: [{ BasicAuth: [] }],
        parameters: [
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", default: 50, maximum: 100, minimum: 1 },
          },
          { name: "offset", in: "query", schema: { type: "integer", default: 0, minimum: 0 } },
        ],
        responses: {
          "200": { description: "ユーザー一覧（ペアワイズsub含む）" },
          "401": { description: "UNAUTHORIZED" },
        },
      },
    },
    "/api/external/users/{id}": {
      get: {
        tags: ["外部サービス向け API"],
        summary: "IDによるユーザー取得",
        description:
          "指定したIDのユーザーを完全一致で取得する。IDOR防止のため、そのサービスを認可済みのユーザーのみ返す。",
        security: [{ BasicAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "ユーザーID",
          },
        ],
        responses: {
          "200": { description: "ユーザー情報（ペアワイズsub含む）" },
          "401": { description: "UNAUTHORIZED" },
          "404": { description: "NOT_FOUND — 未認可または存在しないユーザー" },
        },
      },
    },
    "/api/userinfo": {
      get: {
        tags: ["OIDC"],
        summary: "UserInfo エンドポイント",
        description:
          "OIDC Core 1.0 Section 5.3 準拠のUserInfoエンドポイント。\n\n" +
          "アクセストークンのスコープに応じたクレームを返す。\n\n" +
          "- `scope` なし（BFFセッション）: 全クレームを返す\n" +
          "- `profile` スコープ: `name`, `picture`\n" +
          "- `email` スコープ: `email`, `email_verified`\n" +
          "- `phone` スコープ: `phone_number`\n" +
          "- `address` スコープ: `address`",
        security: [{ BearerAuth: [] }],
        responses: {
          "200": {
            description: "スコープに応じたユーザークレーム",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    sub: {
                      type: "string",
                      description: "ユーザー識別子（サービストークンはペアワイズsub）",
                    },
                    name: { type: "string", description: "表示名（profileスコープ）" },
                    picture: {
                      type: "string",
                      nullable: true,
                      description: "プロフィール画像URL（profileスコープ）",
                    },
                    email: { type: "string", description: "メールアドレス（emailスコープ）" },
                    email_verified: {
                      type: "boolean",
                      description: "メール認証済みフラグ（emailスコープ）",
                    },
                    phone_number: {
                      type: "string",
                      nullable: true,
                      description: "電話番号（phoneスコープ）",
                    },
                    address: {
                      type: "object",
                      nullable: true,
                      description: "住所（addressスコープ）",
                      properties: { formatted: { type: "string" } },
                    },
                    updated_at: { type: "integer", description: "最終更新日時（Unix timestamp）" },
                  },
                  required: ["sub", "updated_at"],
                },
                examples: {
                  full: {
                    value: {
                      sub: "user_abc123",
                      name: "山田 太郎",
                      picture: "https://example.com/photo.jpg",
                      email: "taro@example.com",
                      email_verified: true,
                      updated_at: 1735689600,
                    },
                  },
                },
              },
            },
          },
          "401": { description: "UNAUTHORIZED — トークン無効または期限切れ" },
        },
      },
    },
    "/api/metrics": {
      get: {
        tags: ["管理者 API"],
        summary: "システムメトリクス取得",
        description:
          "総ユーザー数・管理者数・サービス数・アクティブセッション数・直近24時間のログイン数を返す（管理者専用）。",
        security: [{ BearerAuth: [] }],
        responses: {
          "200": {
            description: "メトリクス",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "object",
                      properties: {
                        total_users: { type: "integer", description: "総ユーザー数" },
                        admin_users: { type: "integer", description: "管理者ユーザー数" },
                        total_services: { type: "integer", description: "登録済みサービス数" },
                        active_sessions: {
                          type: "integer",
                          description: "アクティブなリフレッシュトークン数",
                        },
                        recent_logins_24h: {
                          type: "integer",
                          description: "直近24時間のログイン数",
                        },
                      },
                      required: [
                        "total_users",
                        "admin_users",
                        "total_services",
                        "active_sessions",
                        "recent_logins_24h",
                      ],
                    },
                  },
                },
                example: {
                  data: {
                    total_users: 42,
                    admin_users: 2,
                    total_services: 5,
                    active_sessions: 128,
                    recent_logins_24h: 17,
                  },
                },
              },
            },
          },
          "401": { description: "UNAUTHORIZED" },
          "403": { description: "FORBIDDEN — 管理者権限なし" },
        },
      },
    },
    "/api/metrics/dbsc-bindings": {
      get: {
        tags: ["管理者 API"],
        summary: "DBSC 端末バインド集計",
        description:
          "アクティブな BFF セッションのうち、DBSC（Device Bound Session Credentials）で端末バインド済み・未バインドの件数を集計する。\n\n" +
          "`DBSC_ENFORCE_SENSITIVE=true` を本番有効化する前に、Chrome 非対応環境がどれだけ残っているかを棚卸しする用途。公開鍵 JWK 自体は返さない。",
        security: [{ BearerAuth: [] }],
        responses: {
          "200": {
            description: "DBSC バインド集計",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "object",
                      properties: {
                        total: { type: "integer", description: "アクティブな BFF セッション総数" },
                        device_bound: {
                          type: "integer",
                          description: "DBSC 端末バインド済みセッション数",
                        },
                        unbound: { type: "integer", description: "未バインドセッション数" },
                        by_bff_origin: {
                          type: "array",
                          description: "BFF origin 別の内訳",
                          items: {
                            type: "object",
                            properties: {
                              bff_origin: { type: "string" },
                              total: { type: "integer" },
                              device_bound: { type: "integer" },
                              unbound: { type: "integer" },
                            },
                            required: ["bff_origin", "total", "device_bound", "unbound"],
                          },
                        },
                      },
                      required: ["total", "device_bound", "unbound", "by_bff_origin"],
                    },
                  },
                  required: ["data"],
                },
                example: {
                  data: {
                    total: 120,
                    device_bound: 94,
                    unbound: 26,
                    by_bff_origin: [
                      {
                        bff_origin: "https://admin.0g0.xyz",
                        total: 12,
                        device_bound: 12,
                        unbound: 0,
                      },
                      {
                        bff_origin: "https://user.0g0.xyz",
                        total: 108,
                        device_bound: 82,
                        unbound: 26,
                      },
                    ],
                  },
                },
              },
            },
          },
          "401": { description: "UNAUTHORIZED" },
          "403": { description: "FORBIDDEN — 管理者権限なし" },
          "500": { description: "INTERNAL_ERROR" },
        },
      },
    },
    "/api/token/revoke": {
      post: {
        tags: ["トークン"],
        summary: "トークン失効（RFC 7009）",
        description:
          "RFC 7009 準拠のトークン失効エンドポイント。\n\n" +
          "リフレッシュトークンを失効させる。Basic認証（`client_id:client_secret`）が必要。\n\n" +
          "RFC 7009 に従い、トークンが存在しない・失効済みの場合も 200 OK を返す（情報漏洩防止）。\n\n" +
          "`application/json` および `application/x-www-form-urlencoded` 両方を受け付ける。",
        security: [{ BasicAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  token: { type: "string", description: "失効させるリフレッシュトークン" },
                },
                required: ["token"],
              },
            },
            "application/x-www-form-urlencoded": {
              schema: {
                type: "object",
                properties: {
                  token: { type: "string", description: "失効させるリフレッシュトークン" },
                },
                required: ["token"],
              },
            },
          },
        },
        responses: {
          "200": { description: "OK（トークン存在有無に関わらず常に返す）" },
          "400": { description: "BAD_REQUEST — リクエストボディ不正またはtokenフィールドなし" },
          "401": { description: "UNAUTHORIZED — Basic認証失敗" },
        },
      },
    },
    "/.well-known/openid-configuration": {
      get: {
        tags: ["OIDC"],
        summary: "OIDC Discovery Document",
        description:
          "RFC 8414 / OIDC Discovery 1.0 準拠のディスカバリードキュメント。\n\n" +
          "`issuer`, `jwks_uri`, `userinfo_endpoint` など、OIDC プロバイダーとして必要なメタデータを返す。\n\n" +
          "レスポンスは24時間キャッシュ可能（`Cache-Control: public, max-age=86400`）。",
        responses: {
          "200": {
            description: "OIDC プロバイダーメタデータ",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    issuer: { type: "string", example: "https://id.0g0.xyz" },
                    authorization_endpoint: {
                      type: "string",
                      example: "https://id.0g0.xyz/auth/authorize",
                    },
                    token_endpoint: { type: "string", example: "https://id.0g0.xyz/api/token" },
                    jwks_uri: {
                      type: "string",
                      example: "https://id.0g0.xyz/.well-known/jwks.json",
                    },
                    userinfo_endpoint: {
                      type: "string",
                      example: "https://id.0g0.xyz/api/userinfo",
                    },
                    introspection_endpoint: {
                      type: "string",
                      example: "https://id.0g0.xyz/api/token/introspect",
                    },
                    revocation_endpoint: {
                      type: "string",
                      example: "https://id.0g0.xyz/api/token/revoke",
                    },
                    device_authorization_endpoint: {
                      type: "string",
                      example: "https://id.0g0.xyz/api/device/code",
                    },
                    scopes_supported: {
                      type: "array",
                      items: { type: "string" },
                      example: ["openid", "profile", "email", "phone", "address"],
                    },
                    response_types_supported: {
                      type: "array",
                      items: { type: "string" },
                      example: ["code"],
                    },
                    response_modes_supported: {
                      type: "array",
                      items: { type: "string" },
                      example: ["query"],
                    },
                    grant_types_supported: {
                      type: "array",
                      items: { type: "string" },
                      example: [
                        "authorization_code",
                        "refresh_token",
                        "urn:ietf:params:oauth:grant-type:device_code",
                      ],
                    },
                    subject_types_supported: {
                      type: "array",
                      items: { type: "string" },
                      example: ["pairwise"],
                    },
                    id_token_signing_alg_values_supported: {
                      type: "array",
                      items: { type: "string" },
                      example: ["ES256"],
                    },
                    token_endpoint_auth_methods_supported: {
                      type: "array",
                      items: { type: "string" },
                      example: ["client_secret_basic", "none"],
                    },
                    code_challenge_methods_supported: {
                      type: "array",
                      items: { type: "string" },
                      example: ["S256"],
                    },
                    claims_supported: {
                      type: "array",
                      items: { type: "string" },
                      example: [
                        "sub",
                        "iss",
                        "aud",
                        "exp",
                        "iat",
                        "auth_time",
                        "nonce",
                        "name",
                        "picture",
                        "email",
                        "email_verified",
                        "phone_number",
                        "address",
                        "updated_at",
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/.well-known/oauth-authorization-server": {
      get: {
        tags: ["OIDC"],
        summary: "OAuth Authorization Server Metadata",
        description:
          "RFC 8414 準拠の OAuth Authorization Server メタデータ。\n\n" +
          "MCP 仕様で必要とされるエンドポイント情報を返す。\n\n" +
          "レスポンスは24時間キャッシュ可能（`Cache-Control: public, max-age=86400`）。",
        responses: {
          "200": {
            description: "OAuth Authorization Server メタデータ",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    issuer: { type: "string", example: "https://id.0g0.xyz" },
                    authorization_endpoint: {
                      type: "string",
                      example: "https://id.0g0.xyz/auth/authorize",
                    },
                    token_endpoint: { type: "string", example: "https://id.0g0.xyz/api/token" },
                    jwks_uri: {
                      type: "string",
                      example: "https://id.0g0.xyz/.well-known/jwks.json",
                    },
                    scopes_supported: {
                      type: "array",
                      items: { type: "string" },
                      example: ["openid", "profile", "email", "phone", "address"],
                    },
                    response_types_supported: {
                      type: "array",
                      items: { type: "string" },
                      example: ["code"],
                    },
                    response_modes_supported: {
                      type: "array",
                      items: { type: "string" },
                      example: ["query"],
                    },
                    grant_types_supported: {
                      type: "array",
                      items: { type: "string" },
                      example: [
                        "authorization_code",
                        "refresh_token",
                        "urn:ietf:params:oauth:grant-type:device_code",
                      ],
                    },
                    subject_types_supported: {
                      type: "array",
                      items: { type: "string" },
                      example: ["pairwise"],
                    },
                    token_endpoint_auth_methods_supported: {
                      type: "array",
                      items: { type: "string" },
                      example: ["client_secret_basic", "none"],
                    },
                    code_challenge_methods_supported: {
                      type: "array",
                      items: { type: "string" },
                      example: ["S256"],
                    },
                    device_authorization_endpoint: {
                      type: "string",
                      example: "https://id.0g0.xyz/api/device/code",
                    },
                    revocation_endpoint: {
                      type: "string",
                      example: "https://id.0g0.xyz/api/token/revoke",
                    },
                    introspection_endpoint: {
                      type: "string",
                      example: "https://id.0g0.xyz/api/token/introspect",
                    },
                    claims_supported: {
                      type: "array",
                      items: { type: "string" },
                      example: [
                        "sub",
                        "iss",
                        "aud",
                        "exp",
                        "iat",
                        "auth_time",
                        "nonce",
                        "name",
                        "picture",
                        "email",
                        "email_verified",
                        "phone_number",
                        "address",
                        "updated_at",
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/auth/link-intent": {
      post: {
        tags: ["認証フロー"],
        summary: "SNSプロバイダー連携用ワンタイムトークン発行",
        description:
          "認証済みユーザーに対してSNSプロバイダー連携用のワンタイムトークンを発行する。\n\n" +
          "発行されたトークンは `/auth/login?link_token=<token>` の `link_token` パラメータに使用する。\n\n" +
          "トークンの有効期限は2分。URLパラメータで `link_user_id` を直接受け付けるとアカウント乗っ取りが可能なため、このエンドポイントでアクセストークンで認証したうえでワンタイムトークンを発行する設計。",
        security: [{ BearerAuth: [] }],
        responses: {
          "200": {
            description: "ワンタイム連携トークン",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "object",
                      properties: {
                        link_token: {
                          type: "string",
                          description: "2分間有効なワンタイムトークン（JTI付き）",
                        },
                      },
                      required: ["link_token"],
                    },
                  },
                },
                example: { data: { link_token: "abc123def456..." } },
              },
            },
          },
          "401": { description: "UNAUTHORIZED — アクセストークン無効" },
        },
      },
    },
  },
  tags: [
    {
      name: "認証フロー",
      description: "OAuth2.0（Google/LINE/Twitch/GitHub/X）を使ったログイン・トークン管理",
    },
    { name: "OIDC", description: "OIDC Core 1.0 準拠エンドポイント（UserInfo・Discovery）" },
    { name: "ユーザー API", description: "ユーザー自身のプロフィール・連携・ログイン履歴管理" },
    { name: "ユーザー API (管理者)", description: "管理者専用のユーザー管理・ログイン履歴閲覧API" },
    {
      name: "サービス管理 API (管理者)",
      description: "管理者専用のサービス登録・設定・認可ユーザー管理API",
    },
    { name: "管理者 API", description: "管理者専用のシステム管理API（メトリクス等）" },
    { name: "トークン", description: "JWTトークン検証・イントロスペクション・失効" },
    { name: "外部サービス向け API", description: "連携サービス向けのユーザーデータ取得API" },
    { name: "公開エンドポイント", description: "認証不要の公開エンドポイント" },
  ],
};

// 外部連携サービス向け OpenAPI 仕様
// 外部公開API 変更時はこのファイルの paths / components.schemas を更新すること

export const EXTERNAL_OPENAPI = {
  openapi: "3.1.0",
  info: {
    title: "0g0 ID — 外部連携サービス向け API",
    version: "1.0.0",
    description: `# 0g0 ID 連携ガイド

外部サービスが 0g0 ID と連携するためのAPIドキュメントです。

## はじめに: サービス登録

連携を開始する前に、0g0 ID の管理者に連絡してサービスを登録してもらう必要があります。

登録後、以下の認証情報を受け取ります:
- \`client_id\` — サービスを識別するID
- \`client_secret\` — API認証に使用するシークレット（**再取得不可。安全に保管してください**）

## 連携フロー

\`\`\`
外部サービス                    0g0 ID (id.0g0.xyz)
    │                                    │
    │  1. ユーザーが「0g0でログイン」クリック  │
    │──────────────────────────────────>│
    │  GET /auth/login                   │
    │  ?redirect_to=https://myapp.com/cb│
    │  &state=<ランダム値>                │
    │                                    │
    │  2. Googleの認証画面へリダイレクト    │
    │<──────────────────────────────────│
    │                                    │
    │  3. ユーザーがGoogleでログイン       │
    │                                    │
    │  4. ワンタイムコードを受け取る         │
    │<──────────────────────────────────│
    │  GET /callback?code=<code>         │
    │                                    │
    │  5. コードをトークンに交換            │
    │──────────────────────────────────>│
    │  POST /auth/exchange               │
    │  { "code": "..." }                 │
    │                                    │
    │  6. アクセストークン取得              │
    │<──────────────────────────────────│
    │  { access_token, refresh_token }   │
    │                                    │
    │  7. ユーザーデータ取得（External API）│
    │──────────────────────────────────>│
    │  GET /api/external/users/:id       │
    │  Authorization: Basic <cred>       │
    │                                    │
    │  8. スコープに応じたユーザーデータ     │
    │<──────────────────────────────────│
\`\`\`

## Basic 認証の形式

External API は \`client_id:client_secret\` を Base64 エンコードした Basic 認証を使用します:

\`\`\`
Authorization: Basic <Base64(client_id:client_secret)>
\`\`\`

## ペアワイズ識別子（sub）

プライバシー保護のため、External API が返す \`sub\` はサービスごとに固有の不透明な識別子です。
同じユーザーでも異なるサービスには異なる \`sub\` が返ります。内部ユーザーIDは公開されません。

## 利用可能なスコープ

| スコープ | 取得できる情報 |
|---------|-------------|
| \`profile\` | name, picture |
| \`email\` | email, email_verified |
| \`phone\` | phone |
| \`address\` | address |

スコープは管理者がサービス登録時に設定します。`,
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
        description: "`client_id:client_secret` をBase64エンコード",
      },
    },
    schemas: {
      ExternalUser: {
        type: "object",
        description: "スコープに応じたユーザー情報（内部IDの代わりにペアワイズsubを返す）",
        properties: {
          sub: { type: "string", description: "サービス固有のユーザー識別子（ペアワイズ）" },
          name: { type: "string", description: "表示名（profileスコープ）" },
          picture: {
            type: "string",
            nullable: true,
            description: "プロフィール画像URL（profileスコープ）",
          },
          email: { type: "string", description: "メールアドレス（emailスコープ）" },
          email_verified: { type: "boolean", description: "メール認証済みフラグ（emailスコープ）" },
          phone: { type: "string", nullable: true, description: "電話番号（phoneスコープ）" },
          address: { type: "string", nullable: true, description: "住所（addressスコープ）" },
        },
        required: ["sub"],
      },
      Error: {
        type: "object",
        properties: {
          error: {
            type: "object",
            properties: {
              code: { type: "string", example: "UNAUTHORIZED" },
              message: { type: "string", example: "Invalid client credentials" },
            },
            required: ["code", "message"],
          },
        },
      },
    },
  },
  paths: {
    "/auth/authorize": {
      get: {
        tags: ["認証フロー"],
        summary: "標準 OAuth 2.0 / OIDC 認可エンドポイント",
        description:
          "RFC 6749 / RFC 7636 / OIDC Core 1.0 準拠の認可エンドポイント。\n\n" +
          "MCPクライアント・ネイティブアプリ等が直接HTTPリクエストで利用する。\n" +
          "PKCE (S256) 必須。認証後、ユーザーは `redirect_uri` に認可コードとともにリダイレクトされる。\n\n" +
          "```\nGET {redirect_uri}?code=<code>&state=<state>\n```\n\n" +
          "発行された認可コードは `/api/token` (authorization_code grant) で交換する。",
        parameters: [
          {
            name: "response_type",
            in: "query",
            required: true,
            schema: { type: "string", enum: ["code"] },
            description: "`code` 固定（Authorization Code フロー）。",
          },
          {
            name: "client_id",
            in: "query",
            required: true,
            schema: { type: "string", example: "my_service_client_id" },
            description: "登録済みサービスの `client_id`。",
          },
          {
            name: "redirect_uri",
            in: "query",
            required: true,
            schema: { type: "string", format: "uri", example: "https://myapp.com/auth/callback" },
            description:
              "認可コードのコールバックURL。管理者が登録したURIリストと一致する必要がある。",
          },
          {
            name: "state",
            in: "query",
            required: true,
            schema: { type: "string", example: "random_csrf_state_value" },
            description: "CSRF対策用のランダム文字列。コールバック時にそのまま返される。",
          },
          {
            name: "code_challenge",
            in: "query",
            required: true,
            schema: { type: "string", example: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM" },
            description:
              "PKCEコードチャレンジ（`code_verifier` をSHA-256でハッシュしBase64urlエンコード）。",
          },
          {
            name: "code_challenge_method",
            in: "query",
            required: true,
            schema: { type: "string", enum: ["S256"] },
            description: "PKCEメソッド。`S256` のみサポート。",
          },
          {
            name: "scope",
            in: "query",
            required: false,
            schema: { type: "string", example: "openid profile email" },
            description:
              "リクエストするスコープ（スペース区切り）。許可スコープはサービス設定の `allowed_scopes` に制限される。",
          },
          {
            name: "nonce",
            in: "query",
            required: false,
            schema: { type: "string" },
            description: "IDトークンに埋め込むランダム値（OIDC Core 1.0 §3.1.2.1）。最大128文字。",
          },
        ],
        responses: {
          "302": {
            description:
              "プロバイダー選択ページ（USER_ORIGIN/login）にリダイレクト。ユーザーがプロバイダーを選択後、IdP経由で認証が完了し `redirect_uri?code=<code>&state=<state>` にリダイレクトされる。",
          },
          "400": {
            description:
              "invalid_request — パラメータ不正（`client_id` 無効・`redirect_uri` 未登録・PKCEパラメータ不正など）",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/OAuthError" },
                example: {
                  error: "invalid_request",
                  error_description: "redirect_uri not registered for this client",
                },
              },
            },
          },
          "429": {
            description: "TOO_MANY_REQUESTS — レートリミット超過",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
                example: {
                  error: {
                    code: "TOO_MANY_REQUESTS",
                    message: "Too many requests. Please try again later.",
                  },
                },
              },
            },
          },
        },
      },
    },
    "/auth/login": {
      get: {
        tags: ["認証フロー"],
        summary: "ログイン開始（OAuth 2.0 認可エンドポイント）",
        description:
          "ユーザーのログインフローを開始する。外部サービスはこのURLにユーザーをリダイレクトする。\n\n" +
          "**外部サービスは必ず `client_id` を指定すること。** `client_id` を指定した場合、`redirect_to` は\n" +
          "管理者が登録したリダイレクトURIリストに対して検証される。\n\n" +
          "**PKCE（RFC 7636）推奨**: `code_challenge` / `code_challenge_method=S256` を指定することで、\n" +
          "認可コードの傍受攻撃を防げる。`/auth/exchange` 呼び出し時に対応する `code_verifier` を渡す。\n\n" +
          "認証が完了すると `redirect_to` にワンタイムコードとともにリダイレクトされる:\n" +
          "```\nGET {redirect_to}?code=<ワンタイムコード>&state=<state>\n```",
        parameters: [
          {
            name: "redirect_to",
            in: "query",
            required: true,
            schema: { type: "string", format: "uri", example: "https://myapp.com/auth/callback" },
            description:
              "認証後のリダイレクト先URL。`client_id` 指定時は管理者が登録したURIリストと一致する必要がある。HTTPS必須。",
          },
          {
            name: "state",
            in: "query",
            required: true,
            schema: { type: "string", example: "random_csrf_state_value" },
            description:
              "CSRF対策用のランダム文字列。コールバック時にそのまま返される（必ず検証すること）。",
          },
          {
            name: "client_id",
            in: "query",
            required: false,
            schema: { type: "string", example: "my_service_client_id" },
            description:
              "外部サービスの `client_id`（サービス登録時に発行）。外部サービスは必ず指定すること。未指定の場合は内部BFF向けの検証ロジックが使用される。",
          },
          {
            name: "provider",
            in: "query",
            required: false,
            schema: {
              type: "string",
              enum: ["google", "line", "twitch", "github", "x"],
              default: "google",
            },
            description:
              "使用するOAuthプロバイダー。未指定の場合は `google`。利用可能なプロバイダーはサービス設定により異なる。",
          },
          {
            name: "scope",
            in: "query",
            required: false,
            schema: { type: "string", example: "openid profile email" },
            description:
              "リクエストするスコープ（スペース区切り）。許可スコープはサービス設定の `allowed_scopes` に制限される。",
          },
          {
            name: "nonce",
            in: "query",
            required: false,
            schema: { type: "string" },
            description:
              "IDトークン検証用のランダム値（OIDC）。IDトークンの `nonce` クレームとして返される。",
          },
          {
            name: "code_challenge",
            in: "query",
            required: false,
            schema: { type: "string", example: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM" },
            description:
              "PKCEコードチャレンジ（`code_verifier` をSHA-256でハッシュし、Base64urlエンコードした値）。`code_challenge_method=S256` と一緒に指定する。",
          },
          {
            name: "code_challenge_method",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["S256"] },
            description:
              "PKCEのコードチャレンジメソッド。`S256` のみサポート。`code_challenge` 指定時は必須。",
          },
        ],
        responses: {
          "302": {
            description:
              "OAuthプロバイダーの認可画面へリダイレクト。認証完了後、`{redirect_to}?code=<code>&state=<state>` にリダイレクトされる。",
          },
          "400": {
            description:
              "BAD_REQUEST — パラメータ不正（`redirect_to` 未登録・`client_id` 無効・PKCEパラメータ不正など）",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
                example: { error: { code: "BAD_REQUEST", message: "Invalid redirect_to" } },
              },
            },
          },
          "429": {
            description: "TOO_MANY_REQUESTS — レートリミット超過",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
                example: {
                  error: {
                    code: "TOO_MANY_REQUESTS",
                    message: "Too many requests. Please try again later.",
                  },
                },
              },
            },
          },
        },
      },
    },
    "/auth/exchange": {
      post: {
        tags: ["認証フロー"],
        summary: "ワンタイムコードをトークンに交換",
        description:
          "ログイン後にコールバックで受け取ったワンタイムコードを、アクセストークン（15分）とリフレッシュトークン（30日）に交換する。\n\n" +
          "このエンドポイントはサーバーサイドから呼び出すこと（コードは1回しか使えない）。\n\n" +
          "`redirect_to` には `/auth/login` に渡したのと同じコールバックURLを指定する。\n\n" +
          "**認証**: `Authorization: Basic <Base64(client_id:client_secret)>` ヘッダーが必須。\n\n" +
          "**PKCE**: `/auth/login` に `code_challenge` を渡した場合（PKCE使用時）は `code_verifier` も必須。",
        security: [{ BasicAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  code: { type: "string", description: "コールバックで受け取ったワンタイムコード" },
                  redirect_to: {
                    type: "string",
                    description: "コールバックURL（/auth/loginに渡したものと一致が必要）",
                  },
                  code_verifier: {
                    type: "string",
                    description:
                      "PKCEコードベリファイア（`/auth/login` に `code_challenge` を渡した場合は必須。43〜128文字のランダム文字列）",
                    minLength: 43,
                    maxLength: 128,
                  },
                },
                required: ["code", "redirect_to"],
              },
              examples: {
                without_pkce: {
                  summary: "PKCEなし",
                  value: { code: "abc123xyz...", redirect_to: "https://myapp.com/auth/callback" },
                },
                with_pkce: {
                  summary: "PKCE（S256）使用時",
                  value: {
                    code: "abc123xyz...",
                    redirect_to: "https://myapp.com/auth/callback",
                    code_verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
                  },
                },
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
                  properties: {
                    data: {
                      type: "object",
                      properties: {
                        access_token: {
                          type: "string",
                          description: "JWTアクセストークン（ES256、有効期限15分）",
                        },
                        refresh_token: {
                          type: "string",
                          description: "リフレッシュトークン（有効期限30日）",
                        },
                        token_type: { type: "string", example: "Bearer" },
                        expires_in: {
                          type: "integer",
                          example: 900,
                          description: "アクセストークン有効期限（秒）",
                        },
                        user: {
                          type: "object",
                          properties: {
                            id: {
                              type: "string",
                              description: "0g0 ID 内部ユーザーID（External API で使用）",
                            },
                            email: { type: "string" },
                            name: { type: "string" },
                            picture: { type: "string", nullable: true },
                            role: { type: "string", enum: ["user", "admin"] },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          "400": {
            description:
              "BAD_REQUEST — コード不正・redirect_to 不一致・code_verifier 未指定または不一致（PKCE使用時）",
          },
          "401": { description: "UNAUTHORIZED — Basic 認証失敗（client_id/client_secret 不正）" },
          "403": { description: "FORBIDDEN — Authorization ヘッダーなし" },
          "404": { description: "NOT_FOUND — ユーザー未存在" },
        },
      },
    },
    "/auth/refresh": {
      post: {
        tags: ["認証フロー"],
        summary: "アクセストークンの更新",
        description:
          "リフレッシュトークンを使って新しいアクセストークンとリフレッシュトークンを発行する（トークンローテーション）。\n\n" +
          "⚠️ **旧リフレッシュトークンは即時無効化される**。必ず新しいリフレッシュトークンを保存すること。\n\n" +
          "同じリフレッシュトークンを2回使った場合（再使用検出）、そのファミリー全体が失効する（セキュリティ機能）。\n\n" +
          "**認証**: `Authorization: Basic <Base64(client_id:client_secret)>` ヘッダーが必須。",
        security: [{ BasicAuth: [] }],
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
                  properties: {
                    data: {
                      type: "object",
                      properties: {
                        access_token: { type: "string" },
                        refresh_token: {
                          type: "string",
                          description: "新しいリフレッシュトークン（旧トークンは無効）",
                        },
                        token_type: { type: "string", example: "Bearer" },
                        expires_in: { type: "integer", example: 900 },
                      },
                    },
                  },
                },
              },
            },
          },
          "401": {
            description: "UNAUTHORIZED — トークン無効・期限切れ・再使用検出・Basic 認証失敗",
          },
          "403": { description: "FORBIDDEN — Authorization ヘッダーなし" },
        },
      },
    },
    "/auth/logout": {
      post: {
        tags: ["認証フロー"],
        summary: "ログアウト",
        description:
          "リフレッシュトークンファミリー全体を失効させる。ユーザーのログアウト処理で呼び出すこと。\n\n" +
          "**認証**: `Authorization: Basic <Base64(client_id:client_secret)>` ヘッダーが必須。",
        security: [{ BasicAuth: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  refresh_token: {
                    type: "string",
                    description: "失効させるリフレッシュトークン（省略時はno-op）",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "ログアウト成功" },
          "403": { description: "FORBIDDEN — Authorization ヘッダーなし" },
        },
      },
    },
    "/api/token/introspect": {
      post: {
        tags: ["トークン検証"],
        summary: "リフレッシュトークンの有効性確認",
        description:
          "RFC 7662 準拠のトークンイントロスペクションエンドポイント。\n\n" +
          "リフレッシュトークンが有効かどうかを確認し、有効な場合はユーザー情報を返す。\n\n" +
          "認証には Basic 認証（`client_id:client_secret`）を使用する。\n\n" +
          "自サービス向けに発行されたトークンのみ照会可能（他サービスのトークンは `active: false`）。",
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
            description:
              "イントロスペクション結果（active: false はトークン無効・期限切れ・他サービス向け）",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    active: { type: "boolean", description: "トークンが有効かどうか" },
                    sub: {
                      type: "string",
                      description: "ペアワイズユーザー識別子（active: true のみ）",
                    },
                    exp: { type: "integer", description: "有効期限（Unix timestamp）" },
                    scope: { type: "string", description: "許可スコープ（スペース区切り）" },
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
                    phone: {
                      type: "string",
                      nullable: true,
                      description: "電話番号（phoneスコープ）",
                    },
                    address: {
                      type: "string",
                      nullable: true,
                      description: "住所（addressスコープ）",
                    },
                  },
                  required: ["active"],
                },
                examples: {
                  valid: {
                    value: {
                      active: true,
                      sub: "a1b2c3...",
                      exp: 1735689600,
                      scope: "profile email",
                      name: "山田 太郎",
                      email: "taro@example.com",
                      email_verified: true,
                    },
                  },
                  invalid: { value: { active: false } },
                },
              },
            },
          },
          "400": { description: "BAD_REQUEST — リクエストボディ不正" },
          "401": { description: "UNAUTHORIZED — Basic 認証失敗" },
        },
      },
    },
    "/.well-known/jwks.json": {
      get: {
        tags: ["JWT検証"],
        summary: "JWK Set 取得",
        description:
          "JWT署名検証用のES256公開鍵（JWK Set）を返す。\n\n" +
          "アクセストークンの署名をサーバーサイドで検証する場合に使用する。\n\n" +
          "レスポンスは1時間キャッシュ可能（`Cache-Control: public, max-age=3600`）。",
        responses: {
          "200": {
            description: "JWK Set",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    keys: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          kty: { type: "string", example: "EC" },
                          use: { type: "string", example: "sig" },
                          crv: { type: "string", example: "P-256" },
                          kid: { type: "string" },
                          x: { type: "string" },
                          y: { type: "string" },
                          alg: { type: "string", example: "ES256" },
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
    "/api/external/users": {
      get: {
        tags: ["ユーザーデータ取得"],
        summary: "認可済みユーザー一覧取得",
        description:
          "このサービスを認可したユーザーの一覧を返す。\n\n" +
          "返却される `sub` はサービス固有のペアワイズ識別子。\n" +
          "許可されたスコープに応じたフィールドのみ返す。",
        security: [{ BasicAuth: [] }],
        parameters: [
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", default: 50, maximum: 100, minimum: 1 },
            description: "1ページの件数（デフォルト50、最大100）",
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
                    data: {
                      type: "array",
                      items: { $ref: "#/components/schemas/ExternalUser" },
                    },
                    meta: {
                      type: "object",
                      properties: {
                        total: { type: "integer", description: "総ユーザー数" },
                        limit: { type: "integer" },
                        offset: { type: "integer" },
                      },
                    },
                  },
                },
                example: {
                  data: [
                    {
                      sub: "a1b2c3...",
                      name: "山田 太郎",
                      email: "taro@example.com",
                      email_verified: true,
                    },
                  ],
                  meta: { total: 1, limit: 50, offset: 0 },
                },
              },
            },
          },
          "401": {
            description: "認証失敗（client_id または client_secret が不正）",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
                example: { error: { code: "UNAUTHORIZED", message: "Invalid client credentials" } },
              },
            },
          },
          "500": {
            description: "サーバー内部エラー",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        },
      },
    },
    "/api/external/users/{id}": {
      get: {
        tags: ["ユーザーデータ取得"],
        summary: "IDによるユーザー取得",
        description:
          "指定したユーザーIDで完全一致検索を行い、ユーザー情報を返す。\n\n" +
          "セキュリティのため、このサービスを認可していないユーザーのIDを指定した場合も 404 を返す（IDOR防止）。\n\n" +
          "**注意**: このエンドポイントで指定する `id` は 0g0 ID の内部ユーザーID。ペアワイズ `sub` ではない。\n" +
          "内部ユーザーIDは `/auth/exchange` または `/auth/refresh` のレスポンスから取得できる。",
        security: [{ BasicAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "0g0 ID 内部ユーザーID",
          },
        ],
        responses: {
          "200": {
            description: "ユーザー情報",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { data: { $ref: "#/components/schemas/ExternalUser" } },
                },
                example: {
                  data: {
                    sub: "a1b2c3...",
                    name: "山田 太郎",
                    email: "taro@example.com",
                    email_verified: true,
                  },
                },
              },
            },
          },
          "401": {
            description: "認証失敗",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
          "404": {
            description: "ユーザーが存在しない、またはこのサービスを未認可",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
                example: { error: { code: "NOT_FOUND", message: "User not found" } },
              },
            },
          },
          "500": {
            description: "サーバー内部エラー",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        },
      },
    },
    "/api/userinfo": {
      get: {
        tags: ["OIDC"],
        summary: "UserInfo エンドポイント（OIDC Core 1.0）",
        description:
          "OIDC Core 1.0 Section 5.3 準拠のUserInfoエンドポイント。\n\n" +
          "アクセストークンに付与されたスコープに応じたユーザークレームを返す。\n\n" +
          "| スコープ | 返却クレーム |\n" +
          "|---------|------------|\n" +
          "| `profile` | `name`, `picture` |\n" +
          "| `email` | `email`, `email_verified` |\n" +
          "| `phone` | `phone_number` |\n" +
          "| `address` | `address` |\n\n" +
          "`sub` は常にサービス固有のペアワイズ識別子。",
        security: [{ BearerAuth: [] }],
        responses: {
          "200": {
            description: "スコープに応じたユーザークレーム",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    sub: { type: "string", description: "ペアワイズユーザー識別子" },
                    name: { type: "string", description: "表示名（profileスコープ）" },
                    picture: {
                      type: "string",
                      nullable: true,
                      description: "プロフィール画像URL（profileスコープ）",
                    },
                    email: { type: "string", description: "メールアドレス（emailスコープ）" },
                    email_verified: {
                      type: "boolean",
                      description: "メール認証済み（emailスコープ）",
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
                example: {
                  sub: "pairwise_abc123",
                  name: "山田 太郎",
                  picture: "https://example.com/photo.jpg",
                  email: "taro@example.com",
                  email_verified: true,
                  updated_at: 1735689600,
                },
              },
            },
          },
          "401": {
            description: "UNAUTHORIZED — アクセストークン無効・期限切れ",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    error: { type: "string", example: "invalid_token" },
                    error_description: { type: "string", example: "User not found" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/token/revoke": {
      post: {
        tags: ["トークン失効"],
        summary: "リフレッシュトークン失効（RFC 7009）",
        description:
          "RFC 7009 準拠のトークン失効エンドポイント。\n\n" +
          "リフレッシュトークンを明示的に失効させる。Basic認証（`client_id:client_secret`）が必要。\n\n" +
          "- トークンが存在しない・失効済みの場合も 200 OK を返す（RFC 7009 仕様・情報漏洩防止）\n" +
          "- 自サービスが発行したトークンのみ失効可能（他サービスのトークンは no-op）\n" +
          "- `application/json` と `application/x-www-form-urlencoded` の両形式に対応",
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
          "200": { description: "OK（失効処理完了またはno-op）" },
          "400": { description: "BAD_REQUEST — `token` フィールドなし" },
          "401": { description: "UNAUTHORIZED — Basic認証失敗" },
        },
      },
    },
    "/.well-known/openid-configuration": {
      get: {
        tags: ["OIDC"],
        summary: "OIDC Discovery Document",
        description:
          "RFC 8414 / OIDC Discovery 1.0 準拠のプロバイダーメタデータ。\n\n" +
          "レスポンスは24時間キャッシュ可能（`Cache-Control: public, max-age=86400`）。",
        responses: {
          "200": {
            description: "OIDC プロバイダーメタデータ",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    issuer: { type: "string" },
                    authorization_endpoint: { type: "string" },
                    token_endpoint: { type: "string" },
                    jwks_uri: { type: "string" },
                    userinfo_endpoint: { type: "string" },
                    introspection_endpoint: { type: "string" },
                    revocation_endpoint: { type: "string" },
                    device_authorization_endpoint: { type: "string" },
                    scopes_supported: { type: "array", items: { type: "string" } },
                    response_types_supported: { type: "array", items: { type: "string" } },
                    response_modes_supported: { type: "array", items: { type: "string" } },
                    grant_types_supported: { type: "array", items: { type: "string" } },
                    subject_types_supported: { type: "array", items: { type: "string" } },
                    id_token_signing_alg_values_supported: {
                      type: "array",
                      items: { type: "string" },
                    },
                    token_endpoint_auth_methods_supported: {
                      type: "array",
                      items: { type: "string" },
                    },
                    code_challenge_methods_supported: { type: "array", items: { type: "string" } },
                    claims_supported: { type: "array", items: { type: "string" } },
                  },
                },
                example: {
                  issuer: "https://id.0g0.xyz",
                  authorization_endpoint: "https://id.0g0.xyz/auth/authorize",
                  token_endpoint: "https://id.0g0.xyz/api/token",
                  jwks_uri: "https://id.0g0.xyz/.well-known/jwks.json",
                  userinfo_endpoint: "https://id.0g0.xyz/api/userinfo",
                  introspection_endpoint: "https://id.0g0.xyz/api/token/introspect",
                  revocation_endpoint: "https://id.0g0.xyz/api/token/revoke",
                  device_authorization_endpoint: "https://id.0g0.xyz/api/device/code",
                  scopes_supported: ["openid", "profile", "email", "phone", "address"],
                  response_types_supported: ["code"],
                  response_modes_supported: ["query"],
                  grant_types_supported: [
                    "authorization_code",
                    "refresh_token",
                    "urn:ietf:params:oauth:grant-type:device_code",
                  ],
                  subject_types_supported: ["pairwise"],
                  id_token_signing_alg_values_supported: ["ES256"],
                  token_endpoint_auth_methods_supported: ["client_secret_basic", "none"],
                  code_challenge_methods_supported: ["S256"],
                  claims_supported: [
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
                    issuer: { type: "string" },
                    authorization_endpoint: { type: "string" },
                    token_endpoint: { type: "string" },
                    jwks_uri: { type: "string" },
                    scopes_supported: { type: "array", items: { type: "string" } },
                    response_types_supported: { type: "array", items: { type: "string" } },
                    response_modes_supported: { type: "array", items: { type: "string" } },
                    grant_types_supported: { type: "array", items: { type: "string" } },
                    subject_types_supported: { type: "array", items: { type: "string" } },
                    token_endpoint_auth_methods_supported: {
                      type: "array",
                      items: { type: "string" },
                    },
                    code_challenge_methods_supported: { type: "array", items: { type: "string" } },
                    device_authorization_endpoint: { type: "string" },
                    revocation_endpoint: { type: "string" },
                    introspection_endpoint: { type: "string" },
                    claims_supported: { type: "array", items: { type: "string" } },
                  },
                },
                example: {
                  issuer: "https://id.0g0.xyz",
                  authorization_endpoint: "https://id.0g0.xyz/auth/authorize",
                  token_endpoint: "https://id.0g0.xyz/api/token",
                  jwks_uri: "https://id.0g0.xyz/.well-known/jwks.json",
                  scopes_supported: ["openid", "profile", "email", "phone", "address"],
                  response_types_supported: ["code"],
                  response_modes_supported: ["query"],
                  grant_types_supported: [
                    "authorization_code",
                    "refresh_token",
                    "urn:ietf:params:oauth:grant-type:device_code",
                  ],
                  subject_types_supported: ["pairwise"],
                  token_endpoint_auth_methods_supported: ["client_secret_basic", "none"],
                  code_challenge_methods_supported: ["S256"],
                  device_authorization_endpoint: "https://id.0g0.xyz/api/device/code",
                  revocation_endpoint: "https://id.0g0.xyz/api/token/revoke",
                  introspection_endpoint: "https://id.0g0.xyz/api/token/introspect",
                  claims_supported: [
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
  tags: [
    { name: "認証フロー", description: "ログイン・トークン交換・更新・ログアウト" },
    { name: "OIDC", description: "OIDC Core 1.0 準拠エンドポイント（UserInfo・Discovery）" },
    { name: "トークン検証", description: "RFC 7662 トークンイントロスペクション（Basic認証）" },
    { name: "トークン失効", description: "RFC 7009 トークン失効（Basic認証）" },
    { name: "JWT検証", description: "アクセストークンの署名検証用公開鍵" },
    {
      name: "ユーザーデータ取得",
      description: "連携サービス向けのユーザー情報取得API（Basic認証）",
    },
  ],
};

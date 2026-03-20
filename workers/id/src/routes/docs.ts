import { Hono } from 'hono';
import type { IdpEnv } from '@0g0-id/shared';

const app = new Hono<{ Bindings: IdpEnv }>();

// ─── OpenAPI 仕様: IdP 内部向け（全API） ───────────────────────────────
const INTERNAL_OPENAPI = {
  openapi: '3.1.0',
  info: {
    title: '0g0 ID — IdP 内部 API',
    version: '1.0.0',
    description:
      '統合ID基盤（IdP）の内部APIドキュメント。IdPサービス開発者・管理者向け。\n\nベースURL: `https://id.0g0.xyz`',
  },
  servers: [{ url: 'https://id.0g0.xyz', description: '本番環境' }],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'アクセストークン（ES256 JWT、有効期限15分）',
      },
      BasicAuth: {
        type: 'http',
        scheme: 'basic',
        description: 'サービス認証: `client_id:client_secret` をBase64エンコード',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              code: { type: 'string', example: 'UNAUTHORIZED' },
              message: { type: 'string', example: 'Invalid credentials' },
            },
            required: ['code', 'message'],
          },
        },
      },
      LoginEvent: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          user_id: { type: 'string' },
          provider: { type: 'string', enum: ['google', 'line', 'twitch', 'github', 'x'] },
          ip_address: { type: 'string', nullable: true },
          user_agent: { type: 'string', nullable: true },
          created_at: { type: 'string', format: 'date-time' },
        },
        required: ['id', 'user_id', 'provider', 'created_at'],
      },
      User: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          email: { type: 'string' },
          name: { type: 'string' },
          picture: { type: 'string', nullable: true },
          role: { type: 'string', enum: ['user', 'admin'] },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      Service: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          client_id: { type: 'string' },
          allowed_scopes: {
            type: 'array',
            items: { type: 'string' },
          },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      TokenPair: {
        type: 'object',
        properties: {
          access_token: { type: 'string' },
          refresh_token: { type: 'string' },
          token_type: { type: 'string', example: 'Bearer' },
          expires_in: { type: 'integer', example: 900 },
          user: { $ref: '#/components/schemas/User' },
        },
      },
    },
  },
  paths: {
    '/auth/login': {
      get: {
        tags: ['認証フロー'],
        summary: 'ログイン開始',
        description: 'BFFからのリダイレクトを受け取り、Googleの認可画面へリダイレクトする。',
        parameters: [
          {
            name: 'redirect_to',
            in: 'query',
            required: true,
            schema: { type: 'string' },
            description: 'コールバック先URL（user/adminオリジンのみ許可）',
          },
          {
            name: 'state',
            in: 'query',
            required: true,
            schema: { type: 'string' },
            description: 'CSRF対策用ランダム値（BFF生成）',
          },
        ],
        responses: {
          '302': { description: 'Googleの認可画面へリダイレクト' },
        },
      },
    },
    '/auth/callback': {
      get: {
        tags: ['認証フロー'],
        summary: 'Google OAuthコールバック',
        description:
          'Googleからのコールバック。ユーザーを作成/更新し、ワンタイム認可コード（60秒有効）を発行してBFFへリダイレクト。',
        responses: {
          '302': { description: 'BFFへリダイレクト（?code=...）' },
        },
      },
    },
    '/auth/exchange': {
      post: {
        tags: ['認証フロー'],
        summary: 'コードをトークンに交換',
        description:
          'ワンタイムコードをアクセストークン（15分）＋リフレッシュトークン（30日）に交換する。Service Bindingsによるサーバー間通信専用。',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  code: { type: 'string', description: 'ワンタイム認可コード（必須）' },
                },
                required: ['code'],
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'トークン発行成功',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { data: { $ref: '#/components/schemas/TokenPair' } },
                },
              },
            },
          },
          '400': { description: 'BAD_REQUEST — コード不正' },
          '401': { description: 'UNAUTHORIZED — コード無効/期限切れ' },
        },
      },
    },
    '/auth/refresh': {
      post: {
        tags: ['認証フロー'],
        summary: 'アクセストークン更新',
        description:
          'リフレッシュトークンを使って新しいアクセストークンを発行する（トークンローテーション）。再使用検出時はファミリー全体を失効させる。',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  refresh_token: { type: 'string', description: '有効なリフレッシュトークン' },
                },
                required: ['refresh_token'],
              },
            },
          },
        },
        responses: {
          '200': {
            description: '新しいトークンペア',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { data: { $ref: '#/components/schemas/TokenPair' } },
                },
              },
            },
          },
          '401': { description: 'UNAUTHORIZED — トークン無効/再使用検出' },
        },
      },
    },
    '/auth/logout': {
      post: {
        tags: ['認証フロー'],
        summary: 'ログアウト',
        description: 'リフレッシュトークンファミリー全体を失効させる。',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  refresh_token: { type: 'string', description: '失効させるトークン（省略時は何もしない）' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'ログアウト成功' },
        },
      },
    },
    '/api/users/me': {
      get: {
        tags: ['ユーザー API'],
        summary: '自身のプロフィール取得',
        description: '認証済みユーザー自身のプロフィール情報を返す。',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'ユーザー情報',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { data: { $ref: '#/components/schemas/User' } },
                },
              },
            },
          },
          '401': { description: 'UNAUTHORIZED' },
        },
      },
      patch: {
        tags: ['ユーザー API'],
        summary: 'プロフィール更新',
        description: 'ユーザープロフィールを更新する（name必須、picture/phone/address任意）。Origin/RefererヘッダーによるCSRF検証あり。',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: '新しい表示名（空白のみ不可）' },
                  picture: { type: 'string', nullable: true, description: 'プロフィール画像URL（省略時は変更なし）' },
                  phone: { type: 'string', nullable: true, description: '電話番号（省略時は変更なし、nullで削除）' },
                  address: { type: 'string', nullable: true, description: '住所（省略時は変更なし、nullで削除）' },
                },
                required: ['name'],
              },
            },
          },
        },
        responses: {
          '200': {
            description: '更新成功',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { data: { $ref: '#/components/schemas/User' } },
                },
              },
            },
          },
          '400': { description: 'BAD_REQUEST — nameが空' },
          '401': { description: 'UNAUTHORIZED' },
          '403': { description: 'FORBIDDEN — オリジン不正' },
        },
      },
    },
    '/api/users': {
      get: {
        tags: ['ユーザー API (管理者)'],
        summary: 'ユーザー一覧取得',
        description: 'ユーザー一覧を返す（ページネーション対応）。管理者専用。',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 100, minimum: 1 }, description: '1ページの件数' },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0, minimum: 0 }, description: '取得開始位置' },
          { name: 'email', in: 'query', schema: { type: 'string' }, description: 'メールアドレスで部分一致フィルタリング' },
          { name: 'role', in: 'query', schema: { type: 'string', enum: ['user', 'admin'] }, description: 'ロールで絞り込み' },
          { name: 'name', in: 'query', schema: { type: 'string' }, description: '表示名で部分一致フィルタリング' },
        ],
        responses: {
          '200': {
            description: 'ユーザー一覧',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/User' } },
                    total: { type: 'integer' },
                  },
                },
              },
            },
          },
          '401': { description: 'UNAUTHORIZED' },
          '403': { description: 'FORBIDDEN — 管理者権限なし' },
        },
      },
    },
    '/api/users/me/login-history': {
      get: {
        tags: ['ユーザー API'],
        summary: '自分のログイン履歴取得',
        description: '認証済みユーザー自身のログイン履歴を返す（ページネーション対応）。',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100, minimum: 1 }, description: '1ページの件数（デフォルト20、最大100）' },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0, minimum: 0 }, description: '取得開始位置' },
        ],
        responses: {
          '200': {
            description: 'ログイン履歴',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/LoginEvent' } },
                    total: { type: 'integer', description: '総件数' },
                  },
                },
              },
            },
          },
          '401': { description: 'UNAUTHORIZED' },
        },
      },
    },
    '/api/users/me/connections': {
      get: {
        tags: ['ユーザー API'],
        summary: '連携サービス一覧取得',
        description: 'ユーザーがアクティブなリフレッシュトークンを持つ連携サービス一覧を返す。',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: '連携サービス一覧',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          service_id: { type: 'string' },
                          service_name: { type: 'string' },
                          client_id: { type: 'string' },
                          first_authorized_at: { type: 'string', format: 'date-time' },
                          last_authorized_at: { type: 'string', format: 'date-time' },
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
    '/api/users/me/connections/{serviceId}': {
      delete: {
        tags: ['ユーザー API'],
        summary: 'サービス連携解除',
        description: '指定サービスへの連携を解除する（全リフレッシュトークンを失効）。Origin/RefererヘッダーによるCSRF検証あり。',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'serviceId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '204': { description: '連携解除成功' },
          '401': { description: 'UNAUTHORIZED' },
          '403': { description: 'FORBIDDEN — オリジン不正' },
          '404': { description: 'NOT_FOUND — 連携未存在' },
        },
      },
    },
    '/api/users/me/providers': {
      get: {
        tags: ['ユーザー API'],
        summary: '連携済みSNSプロバイダー一覧取得',
        description: 'ユーザーに連携済み・未連携のSNSプロバイダー一覧を返す。',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'プロバイダー一覧',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          provider: { type: 'string', enum: ['google', 'line', 'twitch', 'github', 'x'] },
                          connected: { type: 'boolean' },
                        },
                        required: ['provider', 'connected'],
                      },
                    },
                  },
                },
              },
            },
          },
          '401': { description: 'UNAUTHORIZED' },
        },
      },
    },
    '/api/users/me/providers/{provider}': {
      delete: {
        tags: ['ユーザー API'],
        summary: 'SNSプロバイダー連携解除',
        description: '指定SNSプロバイダーの連携を解除する。最後の連携プロバイダーは解除不可。Origin/RefererヘッダーによるCSRF検証あり。',
        security: [{ BearerAuth: [] }],
        parameters: [
          {
            name: 'provider',
            in: 'path',
            required: true,
            schema: { type: 'string', enum: ['google', 'line', 'twitch', 'github', 'x'] },
            description: 'SNSプロバイダー名',
          },
        ],
        responses: {
          '204': { description: '連携解除成功' },
          '400': { description: 'BAD_REQUEST — 不正なプロバイダー名' },
          '401': { description: 'UNAUTHORIZED' },
          '403': { description: 'FORBIDDEN — オリジン不正' },
          '404': { description: 'NOT_FOUND — プロバイダー未連携' },
          '409': { description: 'CONFLICT — 最後のプロバイダーは解除不可' },
        },
      },
    },
    '/api/users/{id}/role': {
      patch: {
        tags: ['ユーザー API (管理者)'],
        summary: 'ユーザーロール変更',
        description: '指定ユーザーのロールを変更する（管理者専用）。変更後は既存トークンを即時失効。自分自身のロール変更は不可。',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  role: { type: 'string', enum: ['user', 'admin'], description: '新しいロール' },
                },
                required: ['role'],
              },
            },
          },
        },
        responses: {
          '200': { description: 'ロール変更成功' },
          '400': { description: 'BAD_REQUEST — 不正なロール値' },
          '401': { description: 'UNAUTHORIZED' },
          '403': { description: 'FORBIDDEN — 管理者権限なし、または自分自身のロール変更' },
          '404': { description: 'NOT_FOUND — ユーザー未存在' },
        },
      },
    },
    '/api/users/{id}/services': {
      get: {
        tags: ['ユーザー API (管理者)'],
        summary: 'ユーザーの認可済みサービス一覧取得',
        description: '指定ユーザーが現在アクティブなリフレッシュトークンを保有するサービス一覧を返す（管理者専用）。`GET /api/services/{id}/users` の逆方向エンドポイント。',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'ユーザーID' },
        ],
        responses: {
          '200': {
            description: '認可済みサービス一覧',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          service_id: { type: 'string' },
                          service_name: { type: 'string' },
                          client_id: { type: 'string' },
                          first_authorized_at: { type: 'string', format: 'date-time' },
                          last_authorized_at: { type: 'string', format: 'date-time' },
                        },
                        required: ['service_id', 'service_name', 'client_id', 'first_authorized_at', 'last_authorized_at'],
                      },
                    },
                  },
                },
              },
            },
          },
          '401': { description: 'UNAUTHORIZED' },
          '403': { description: 'FORBIDDEN — 管理者権限なし' },
          '404': { description: 'NOT_FOUND — ユーザー未存在' },
        },
      },
    },
    '/api/users/{id}/login-history': {
      get: {
        tags: ['ユーザー API (管理者)'],
        summary: 'ユーザーのログイン履歴取得',
        description: '指定ユーザーのログイン履歴を返す（管理者専用、ページネーション対応）。',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'ユーザーID' },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100, minimum: 1 }, description: '1ページの件数（デフォルト20、最大100）' },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0, minimum: 0 }, description: '取得開始位置' },
        ],
        responses: {
          '200': {
            description: 'ログイン履歴',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/LoginEvent' } },
                    total: { type: 'integer', description: '総件数' },
                  },
                },
              },
            },
          },
          '401': { description: 'UNAUTHORIZED' },
          '403': { description: 'FORBIDDEN — 管理者権限なし' },
          '404': { description: 'NOT_FOUND — ユーザー未存在' },
        },
      },
    },
    '/api/users/{id}/providers': {
      get: {
        tags: ['ユーザー API (管理者)'],
        summary: 'ユーザーのSNSプロバイダー連携状態取得',
        description: '指定ユーザーの連携済み・未連携のSNSプロバイダー一覧を返す（管理者専用）。',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'ユーザーID' },
        ],
        responses: {
          '200': {
            description: 'プロバイダー一覧',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          provider: { type: 'string', enum: ['google', 'line', 'twitch', 'github', 'x'] },
                          connected: { type: 'boolean' },
                        },
                        required: ['provider', 'connected'],
                      },
                    },
                  },
                },
              },
            },
          },
          '401': { description: 'UNAUTHORIZED' },
          '403': { description: 'FORBIDDEN — 管理者権限なし' },
          '404': { description: 'NOT_FOUND — ユーザー未存在' },
        },
      },
    },
    '/api/users/{id}': {
      get: {
        tags: ['ユーザー API (管理者)'],
        summary: 'ユーザー詳細取得',
        description: '指定ユーザーの詳細情報を返す（管理者専用）。phone / address など内部フィールドも含む。',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'ユーザー詳細',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      allOf: [
                        { $ref: '#/components/schemas/User' },
                        {
                          type: 'object',
                          properties: {
                            phone: { type: 'string', nullable: true },
                            address: { type: 'string', nullable: true },
                            updated_at: { type: 'string', format: 'date-time' },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
          '401': { description: 'UNAUTHORIZED' },
          '403': { description: 'FORBIDDEN — 管理者権限なし' },
          '404': { description: 'NOT_FOUND — ユーザー未存在' },
        },
      },
      delete: {
        tags: ['ユーザー API (管理者)'],
        summary: 'ユーザー削除',
        description: '指定ユーザーを削除する（管理者専用）。自分自身の削除は不可。サービス所有者は所有権移譲後でないと削除不可。',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '204': { description: '削除成功' },
          '401': { description: 'UNAUTHORIZED' },
          '403': { description: 'FORBIDDEN — 管理者権限なし、または自分自身の削除' },
          '404': { description: 'NOT_FOUND — ユーザー未存在' },
          '409': { description: 'CONFLICT — サービス所有者は削除不可' },
        },
      },
    },
    '/api/services': {
      get: {
        tags: ['サービス管理 API (管理者)'],
        summary: '登録済みサービス一覧取得',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'サービス一覧',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Service' } } },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ['サービス管理 API (管理者)'],
        summary: 'サービス登録',
        description: '新しいサービスを登録する。`client_secret` は作成時のみ返却（再取得不可）。',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'サービス名（必須）' },
                  allowed_scopes: {
                    type: 'array',
                    items: { type: 'string', enum: ['profile', 'email', 'phone', 'address'] },
                    description: '許可スコープ（省略時: ["profile","email"]）',
                  },
                },
                required: ['name'],
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'サービス作成成功（client_secretを含む）',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      allOf: [
                        { $ref: '#/components/schemas/Service' },
                        { type: 'object', properties: { client_secret: { type: 'string' } } },
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
    '/api/services/{id}': {
      get: {
        tags: ['サービス管理 API (管理者)'],
        summary: 'サービス取得',
        description: '指定IDのサービス詳細を返す（管理者専用）。',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'サービス詳細',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { data: { $ref: '#/components/schemas/Service' } },
                },
              },
            },
          },
          '401': { description: 'UNAUTHORIZED' },
          '403': { description: 'FORBIDDEN — 管理者権限なし' },
          '404': { description: 'NOT_FOUND — サービス未存在' },
        },
      },
      patch: {
        tags: ['サービス管理 API (管理者)'],
        summary: 'サービス情報更新',
        description: '指定サービスの名前・許可スコープを更新する（管理者専用）。name と allowed_scopes の少なくとも一方が必要。Origin/RefererヘッダーによるCSRF検証あり。',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: '新しいサービス名（省略時は変更なし、空文字不可）' },
                  allowed_scopes: {
                    type: 'array',
                    items: { type: 'string', enum: ['profile', 'email', 'phone', 'address'] },
                    description: '新しい許可スコープ（省略時は変更なし、空配列不可）',
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: '更新成功',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { data: { $ref: '#/components/schemas/Service' } },
                },
              },
            },
          },
          '400': { description: 'BAD_REQUEST — 不正なスコープ値または空配列' },
          '401': { description: 'UNAUTHORIZED' },
          '403': { description: 'FORBIDDEN — 管理者権限なし、またはオリジン不正' },
          '404': { description: 'NOT_FOUND — サービス未存在' },
        },
      },
      delete: {
        tags: ['サービス管理 API (管理者)'],
        summary: 'サービス削除',
        description: '指定サービスを削除する（管理者専用）。Origin/RefererヘッダーによるCSRF検証あり。',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '204': { description: '削除成功' },
          '401': { description: 'UNAUTHORIZED' },
          '403': { description: 'FORBIDDEN — 管理者権限なし、またはオリジン不正' },
          '404': { description: 'NOT_FOUND — サービス未存在' },
        },
      },
    },
    '/api/services/{id}/rotate-secret': {
      post: {
        tags: ['サービス管理 API (管理者)'],
        summary: 'クライアントシークレット再発行',
        description:
          '指定サービスのクライアントシークレットを再発行する（管理者専用）。' +
          '旧シークレットは即時無効化される。新しい `client_secret` はこのレスポンスのみで返却（再取得不可）。' +
          'Origin/RefererヘッダーによるCSRF検証あり。',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: '再発行成功（新しいclient_secretを含む）',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        client_id: { type: 'string' },
                        client_secret: { type: 'string', description: '新しいクライアントシークレット（このレスポンスのみ）' },
                        updated_at: { type: 'string', format: 'date-time' },
                      },
                      required: ['id', 'client_id', 'client_secret', 'updated_at'],
                    },
                  },
                },
              },
            },
          },
          '401': { description: 'UNAUTHORIZED' },
          '403': { description: 'FORBIDDEN — 管理者権限なし、またはオリジン不正' },
          '404': { description: 'NOT_FOUND — サービス未存在' },
        },
      },
    },
    '/api/services/{id}/owner': {
      patch: {
        tags: ['サービス管理 API (管理者)'],
        summary: 'サービス所有権移譲',
        description: '指定サービスの所有権を別ユーザーに移譲する（管理者専用）。移譲先ユーザーが存在しない場合は 404 を返す。Origin/RefererヘッダーによるCSRF検証あり。',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'サービスID' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  new_owner_user_id: { type: 'string', description: '新しいオーナーのユーザーID（必須）' },
                },
                required: ['new_owner_user_id'],
              },
            },
          },
        },
        responses: {
          '200': {
            description: '移譲成功',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        name: { type: 'string' },
                        client_id: { type: 'string' },
                        owner_user_id: { type: 'string' },
                        updated_at: { type: 'string', format: 'date-time' },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': { description: 'BAD_REQUEST — new_owner_user_id が未指定' },
          '401': { description: 'UNAUTHORIZED' },
          '403': { description: 'FORBIDDEN — 管理者権限なし、またはオリジン不正' },
          '404': { description: 'NOT_FOUND — サービスまたは移譲先ユーザーが未存在' },
        },
      },
    },
    '/api/services/{id}/users': {
      get: {
        tags: ['サービス管理 API (管理者)'],
        summary: 'サービス認可済みユーザー一覧取得',
        description: '指定サービスにアクティブなリフレッシュトークンを持つ認可済みユーザー一覧を返す（管理者専用、ページネーション対応）。',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'サービスID' },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 100, minimum: 1 }, description: '1ページの件数' },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0, minimum: 0 }, description: '取得開始位置' },
        ],
        responses: {
          '200': {
            description: '認可済みユーザー一覧',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/User' } },
                    total: { type: 'integer', description: '総ユーザー数' },
                  },
                },
              },
            },
          },
          '401': { description: 'UNAUTHORIZED' },
          '403': { description: 'FORBIDDEN — 管理者権限なし' },
          '404': { description: 'NOT_FOUND — サービス未存在' },
        },
      },
    },
    '/api/services/{id}/users/{userId}': {
      delete: {
        tags: ['サービス管理 API (管理者)'],
        summary: 'ユーザーのサービスアクセス失効',
        description: '指定ユーザーの指定サービスに対するすべてのリフレッシュトークンを失効させる（管理者専用）。ユーザーのサービスアクセスを強制的に取り消す。Origin/RefererヘッダーによるCSRF検証あり。',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'サービスID' },
          { name: 'userId', in: 'path', required: true, schema: { type: 'string' }, description: 'ユーザーID' },
        ],
        responses: {
          '204': { description: 'アクセス失効成功' },
          '401': { description: 'UNAUTHORIZED' },
          '403': { description: 'FORBIDDEN — 管理者権限なし、またはオリジン不正' },
          '404': { description: 'NOT_FOUND — サービス未存在、ユーザー未存在、またはユーザーの認可が存在しない' },
        },
      },
    },
    '/api/services/{id}/redirect-uris': {
      get: {
        tags: ['サービス管理 API (管理者)'],
        summary: 'リダイレクトURI一覧取得',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'URI一覧' },
        },
      },
      post: {
        tags: ['サービス管理 API (管理者)'],
        summary: 'リダイレクトURI追加',
        description: 'HTTPS必須（localhost例外あり）、fragment禁止、自動正規化。',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { uri: { type: 'string', description: '追加するリダイレクトURI' } },
                required: ['uri'],
              },
            },
          },
        },
        responses: {
          '201': { description: '追加成功' },
          '409': { description: 'CONFLICT — 重複URI' },
        },
      },
    },
    '/api/services/{id}/redirect-uris/{uriId}': {
      delete: {
        tags: ['サービス管理 API (管理者)'],
        summary: 'リダイレクトURI削除',
        description: '指定リダイレクトURIを削除する（管理者専用）。Origin/RefererヘッダーによるCSRF検証あり。',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'uriId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '204': { description: '削除成功' },
          '401': { description: 'UNAUTHORIZED' },
          '403': { description: 'FORBIDDEN — 管理者権限なし、またはオリジン不正' },
          '404': { description: 'NOT_FOUND — サービス未存在' },
        },
      },
    },
    '/api/token/introspect': {
      post: {
        tags: ['トークン'],
        summary: 'トークンイントロスペクション',
        description: 'RFC 7662 準拠のトークン検証エンドポイント。Basic認証（client_id:client_secret）が必要。',
        security: [{ BasicAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { token: { type: 'string', description: '検証するリフレッシュトークン' } },
                required: ['token'],
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'イントロスペクション結果',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    active: { type: 'boolean' },
                    sub: { type: 'string' },
                    exp: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/.well-known/jwks.json': {
      get: {
        tags: ['公開エンドポイント'],
        summary: 'JWK Set取得',
        description: 'JWT署名検証用のES256公開鍵（JWK Set）を返す。',
        responses: {
          '200': { description: 'JWK Set' },
        },
      },
    },
    '/api/health': {
      get: {
        tags: ['公開エンドポイント'],
        summary: 'ヘルスチェック',
        responses: {
          '200': {
            description: '正常',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'ok' },
                    worker: { type: 'string', example: 'id' },
                    timestamp: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/external/users': {
      get: {
        tags: ['外部サービス向け API'],
        summary: '認可済みユーザー一覧取得',
        description: 'このサービスを認可済みのユーザー一覧を返す（ページネーション対応）。',
        security: [{ BasicAuth: [] }],
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 100, minimum: 1 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0, minimum: 0 } },
        ],
        responses: {
          '200': { description: 'ユーザー一覧（ペアワイズsub含む）' },
          '401': { description: 'UNAUTHORIZED' },
        },
      },
    },
    '/api/external/users/{id}': {
      get: {
        tags: ['外部サービス向け API'],
        summary: 'IDによるユーザー取得',
        description: '指定したIDのユーザーを完全一致で取得する。IDOR防止のため、そのサービスを認可済みのユーザーのみ返す。',
        security: [{ BasicAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'ユーザーID' },
        ],
        responses: {
          '200': { description: 'ユーザー情報（ペアワイズsub含む）' },
          '401': { description: 'UNAUTHORIZED' },
          '404': { description: 'NOT_FOUND — 未認可または存在しないユーザー' },
        },
      },
    },
  },
  tags: [
    { name: '認証フロー', description: 'OAuth2.0（Google/LINE/Twitch/GitHub/X）を使ったログイン・トークン管理' },
    { name: 'ユーザー API', description: 'ユーザー自身のプロフィール・連携・ログイン履歴管理' },
    { name: 'ユーザー API (管理者)', description: '管理者専用のユーザー管理・ログイン履歴閲覧API' },
    { name: 'サービス管理 API (管理者)', description: '管理者専用のサービス登録・設定・認可ユーザー管理API' },
    { name: 'トークン', description: 'JWTトークン検証・イントロスペクション' },
    { name: '外部サービス向け API', description: '連携サービス向けのユーザーデータ取得API' },
    { name: '公開エンドポイント', description: '認証不要の公開エンドポイント' },
  ],
};

// ─── OpenAPI 仕様: 外部連携サービス向け ───────────────────────────────
const EXTERNAL_OPENAPI = {
  openapi: '3.1.0',
  info: {
    title: '0g0 ID — 外部連携サービス向け API',
    version: '1.0.0',
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
  servers: [{ url: 'https://id.0g0.xyz', description: '本番環境' }],
  components: {
    securitySchemes: {
      BasicAuth: {
        type: 'http',
        scheme: 'basic',
        description: '`client_id:client_secret` をBase64エンコード',
      },
    },
    schemas: {
      ExternalUser: {
        type: 'object',
        description: 'スコープに応じたユーザー情報（内部IDの代わりにペアワイズsubを返す）',
        properties: {
          sub: { type: 'string', description: 'サービス固有のユーザー識別子（ペアワイズ）' },
          name: { type: 'string', description: '表示名（profileスコープ）' },
          picture: { type: 'string', nullable: true, description: 'プロフィール画像URL（profileスコープ）' },
          email: { type: 'string', description: 'メールアドレス（emailスコープ）' },
          email_verified: { type: 'boolean', description: 'メール認証済みフラグ（emailスコープ）' },
          phone: { type: 'string', nullable: true, description: '電話番号（phoneスコープ）' },
          address: { type: 'string', nullable: true, description: '住所（addressスコープ）' },
        },
        required: ['sub'],
      },
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              code: { type: 'string', example: 'UNAUTHORIZED' },
              message: { type: 'string', example: 'Invalid client credentials' },
            },
            required: ['code', 'message'],
          },
        },
      },
    },
  },
  paths: {
    '/api/external/users': {
      get: {
        tags: ['ユーザーデータ取得'],
        summary: '認可済みユーザー一覧取得',
        description:
          'このサービスを認可したユーザーの一覧を返す。\n\n' +
          '返却される `sub` はサービス固有のペアワイズ識別子。\n' +
          '許可されたスコープに応じたフィールドのみ返す。',
        security: [{ BasicAuth: [] }],
        parameters: [
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', default: 50, maximum: 100, minimum: 1 },
            description: '1ページの件数（デフォルト50、最大100）',
          },
          {
            name: 'offset',
            in: 'query',
            schema: { type: 'integer', default: 0, minimum: 0 },
            description: '取得開始位置',
          },
        ],
        responses: {
          '200': {
            description: '認可済みユーザー一覧',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/ExternalUser' },
                    },
                    meta: {
                      type: 'object',
                      properties: {
                        total: { type: 'integer', description: '総ユーザー数' },
                        limit: { type: 'integer' },
                        offset: { type: 'integer' },
                      },
                    },
                  },
                },
                example: {
                  data: [
                    { sub: 'a1b2c3...', name: '山田 太郎', email: 'taro@example.com', email_verified: true },
                  ],
                  meta: { total: 1, limit: 50, offset: 0 },
                },
              },
            },
          },
          '401': {
            description: '認証失敗（client_id または client_secret が不正）',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
                example: { error: { code: 'UNAUTHORIZED', message: 'Invalid client credentials' } },
              },
            },
          },
          '500': {
            description: 'サーバー内部エラー',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
        },
      },
    },
    '/api/external/users/{id}': {
      get: {
        tags: ['ユーザーデータ取得'],
        summary: 'IDによるユーザー取得',
        description:
          '指定したユーザーIDで完全一致検索を行い、ユーザー情報を返す。\n\n' +
          'セキュリティのため、このサービスを認可していないユーザーのIDを指定した場合も 404 を返す（IDOR防止）。\n\n' +
          '**注意**: このエンドポイントで指定する `id` は 0g0 ID の内部ユーザーID。ペアワイズ `sub` ではない。\n' +
          '内部ユーザーIDは `/auth/exchange` または `/auth/refresh` のレスポンスから取得できる。',
        security: [{ BasicAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: '0g0 ID 内部ユーザーID',
          },
        ],
        responses: {
          '200': {
            description: 'ユーザー情報',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { data: { $ref: '#/components/schemas/ExternalUser' } },
                },
                example: {
                  data: { sub: 'a1b2c3...', name: '山田 太郎', email: 'taro@example.com', email_verified: true },
                },
              },
            },
          },
          '401': {
            description: '認証失敗',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
          '404': {
            description: 'ユーザーが存在しない、またはこのサービスを未認可',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
                example: { error: { code: 'NOT_FOUND', message: 'User not found' } },
              },
            },
          },
          '500': {
            description: 'サーバー内部エラー',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
        },
      },
    },
  },
  tags: [
    { name: 'ユーザーデータ取得', description: '連携サービス向けのユーザー情報取得API（Basic認証）' },
  ],
};

// バージョン固定済みのScalar CDN URL（サプライチェーン攻撃リスク低減）
// SRIハッシュはデプロイパイプラインで付与すること
const SCALAR_CDN = 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.49.1';

// ─── Scalar HTML テンプレート ────────────────────────────────────────
function scalarHtml(specUrl: string, title: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body>
  <script id="api-reference" data-url="${specUrl}"></script>
  <script src="${SCALAR_CDN}" crossorigin="anonymous"></script>
</body>
</html>`;
}

// ─── ルート定義 ────────────────────────────────────────────────────
// IdP 開発者向け: 全API（内部利用）
app.get('/', (c) => c.html(scalarHtml('/docs/openapi.json', '0g0 ID API — IdP 開発者向け')));
// 内部向け仕様は開発者ネットワーク内での参照を想定。本番では Cloudflare Access 等で保護すること
app.get('/openapi.json', (c) => c.json(INTERNAL_OPENAPI));

// 外部連携サービス向け: 外部API + 連携フロー
app.get('/external', (c) =>
  c.html(scalarHtml('/docs/external/openapi.json', '0g0 ID API — 外部連携サービス向け'))
);
app.get('/external/openapi.json', (c) => c.json(EXTERNAL_OPENAPI));

export default app;

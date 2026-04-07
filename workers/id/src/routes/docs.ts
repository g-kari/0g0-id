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
    '/api/users/me/tokens': {
      get: {
        tags: ['ユーザー API'],
        summary: 'アクティブセッション一覧取得',
        description: '認証済みユーザー自身のアクティブなセッション（リフレッシュトークン）一覧を返す。IdPセッションと外部サービストークン両方を含む。',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'アクティブセッション一覧',
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
                          id: { type: 'string', description: 'セッションID' },
                          service_id: { type: 'string', nullable: true, description: '外部サービスID（IdPセッションはnull）' },
                          service_name: { type: 'string', nullable: true, description: 'サービス名（IdPセッションはnull）' },
                          created_at: { type: 'string', format: 'date-time' },
                          expires_at: { type: 'string', format: 'date-time' },
                        },
                        required: ['id', 'service_id', 'service_name', 'created_at', 'expires_at'],
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
    '/api/userinfo': {
      get: {
        tags: ['OIDC'],
        summary: 'UserInfo エンドポイント',
        description:
          'OIDC Core 1.0 Section 5.3 準拠のUserInfoエンドポイント。\n\n' +
          'アクセストークンのスコープに応じたクレームを返す。\n\n' +
          '- `scope` なし（BFFセッション）: 全クレームを返す\n' +
          '- `profile` スコープ: `name`, `picture`\n' +
          '- `email` スコープ: `email`, `email_verified`\n' +
          '- `phone` スコープ: `phone_number`\n' +
          '- `address` スコープ: `address`',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'スコープに応じたユーザークレーム',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    sub: { type: 'string', description: 'ユーザー識別子（サービストークンはペアワイズsub）' },
                    name: { type: 'string', description: '表示名（profileスコープ）' },
                    picture: { type: 'string', nullable: true, description: 'プロフィール画像URL（profileスコープ）' },
                    email: { type: 'string', description: 'メールアドレス（emailスコープ）' },
                    email_verified: { type: 'boolean', description: 'メール認証済みフラグ（emailスコープ）' },
                    phone_number: { type: 'string', nullable: true, description: '電話番号（phoneスコープ）' },
                    address: {
                      type: 'object',
                      nullable: true,
                      description: '住所（addressスコープ）',
                      properties: { formatted: { type: 'string' } },
                    },
                    updated_at: { type: 'integer', description: '最終更新日時（Unix timestamp）' },
                  },
                  required: ['sub', 'updated_at'],
                },
                examples: {
                  full: {
                    value: {
                      sub: 'user_abc123',
                      name: '山田 太郎',
                      picture: 'https://example.com/photo.jpg',
                      email: 'taro@example.com',
                      email_verified: true,
                      updated_at: 1735689600,
                    },
                  },
                },
              },
            },
          },
          '401': { description: 'UNAUTHORIZED — トークン無効または期限切れ' },
        },
      },
    },
    '/api/metrics': {
      get: {
        tags: ['管理者 API'],
        summary: 'システムメトリクス取得',
        description: '総ユーザー数・管理者数・サービス数・アクティブセッション数・直近24時間のログイン数を返す（管理者専用）。',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'メトリクス',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'object',
                      properties: {
                        total_users: { type: 'integer', description: '総ユーザー数' },
                        admin_users: { type: 'integer', description: '管理者ユーザー数' },
                        total_services: { type: 'integer', description: '登録済みサービス数' },
                        active_sessions: { type: 'integer', description: 'アクティブなリフレッシュトークン数' },
                        recent_logins_24h: { type: 'integer', description: '直近24時間のログイン数' },
                      },
                      required: ['total_users', 'admin_users', 'total_services', 'active_sessions', 'recent_logins_24h'],
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
          '401': { description: 'UNAUTHORIZED' },
          '403': { description: 'FORBIDDEN — 管理者権限なし' },
        },
      },
    },
    '/api/token/revoke': {
      post: {
        tags: ['トークン'],
        summary: 'トークン失効（RFC 7009）',
        description:
          'RFC 7009 準拠のトークン失効エンドポイント。\n\n' +
          'リフレッシュトークンを失効させる。Basic認証（`client_id:client_secret`）が必要。\n\n' +
          'RFC 7009 に従い、トークンが存在しない・失効済みの場合も 200 OK を返す（情報漏洩防止）。\n\n' +
          '`application/json` および `application/x-www-form-urlencoded` 両方を受け付ける。',
        security: [{ BasicAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { token: { type: 'string', description: '失効させるリフレッシュトークン' } },
                required: ['token'],
              },
            },
            'application/x-www-form-urlencoded': {
              schema: {
                type: 'object',
                properties: { token: { type: 'string', description: '失効させるリフレッシュトークン' } },
                required: ['token'],
              },
            },
          },
        },
        responses: {
          '200': { description: 'OK（トークン存在有無に関わらず常に返す）' },
          '400': { description: 'BAD_REQUEST — リクエストボディ不正またはtokenフィールドなし' },
          '401': { description: 'UNAUTHORIZED — Basic認証失敗' },
        },
      },
    },
    '/.well-known/openid-configuration': {
      get: {
        tags: ['OIDC'],
        summary: 'OIDC Discovery Document',
        description:
          'RFC 8414 / OIDC Discovery 1.0 準拠のディスカバリードキュメント。\n\n' +
          '`issuer`, `jwks_uri`, `userinfo_endpoint` など、OIDC プロバイダーとして必要なメタデータを返す。\n\n' +
          'レスポンスは24時間キャッシュ可能（`Cache-Control: public, max-age=86400`）。',
        responses: {
          '200': {
            description: 'OIDC プロバイダーメタデータ',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    issuer: { type: 'string', example: 'https://id.0g0.xyz' },
                    authorization_endpoint: { type: 'string', example: 'https://id.0g0.xyz/auth/authorize' },
                    token_endpoint: { type: 'string', example: 'https://id.0g0.xyz/api/token' },
                    jwks_uri: { type: 'string', example: 'https://id.0g0.xyz/.well-known/jwks.json' },
                    userinfo_endpoint: { type: 'string', example: 'https://id.0g0.xyz/api/userinfo' },
                    introspection_endpoint: { type: 'string', example: 'https://id.0g0.xyz/api/token/introspect' },
                    revocation_endpoint: { type: 'string', example: 'https://id.0g0.xyz/api/token/revoke' },
                    device_authorization_endpoint: { type: 'string', example: 'https://id.0g0.xyz/api/device/code' },
                    scopes_supported: { type: 'array', items: { type: 'string' }, example: ['openid', 'profile', 'email', 'phone', 'address'] },
                    response_types_supported: { type: 'array', items: { type: 'string' }, example: ['code'] },
                    response_modes_supported: { type: 'array', items: { type: 'string' }, example: ['query'] },
                    grant_types_supported: { type: 'array', items: { type: 'string' }, example: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'] },
                    subject_types_supported: { type: 'array', items: { type: 'string' }, example: ['pairwise'] },
                    id_token_signing_alg_values_supported: { type: 'array', items: { type: 'string' }, example: ['ES256'] },
                    token_endpoint_auth_methods_supported: { type: 'array', items: { type: 'string' }, example: ['client_secret_basic', 'none'] },
                    code_challenge_methods_supported: { type: 'array', items: { type: 'string' }, example: ['S256'] },
                    claims_supported: { type: 'array', items: { type: 'string' }, example: ['sub', 'iss', 'aud', 'exp', 'iat', 'auth_time', 'nonce', 'name', 'picture', 'email', 'email_verified', 'phone_number', 'address', 'updated_at'] },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/.well-known/oauth-authorization-server': {
      get: {
        tags: ['OIDC'],
        summary: 'OAuth Authorization Server Metadata',
        description:
          'RFC 8414 準拠の OAuth Authorization Server メタデータ。\n\n' +
          'MCP 仕様で必要とされるエンドポイント情報を返す。\n\n' +
          'レスポンスは24時間キャッシュ可能（`Cache-Control: public, max-age=86400`）。',
        responses: {
          '200': {
            description: 'OAuth Authorization Server メタデータ',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    issuer: { type: 'string', example: 'https://id.0g0.xyz' },
                    authorization_endpoint: { type: 'string', example: 'https://id.0g0.xyz/auth/authorize' },
                    token_endpoint: { type: 'string', example: 'https://id.0g0.xyz/api/token' },
                    jwks_uri: { type: 'string', example: 'https://id.0g0.xyz/.well-known/jwks.json' },
                    scopes_supported: { type: 'array', items: { type: 'string' }, example: ['openid', 'profile', 'email', 'phone', 'address'] },
                    response_types_supported: { type: 'array', items: { type: 'string' }, example: ['code'] },
                    response_modes_supported: { type: 'array', items: { type: 'string' }, example: ['query'] },
                    grant_types_supported: { type: 'array', items: { type: 'string' }, example: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'] },
                    subject_types_supported: { type: 'array', items: { type: 'string' }, example: ['pairwise'] },
                    token_endpoint_auth_methods_supported: { type: 'array', items: { type: 'string' }, example: ['client_secret_basic', 'none'] },
                    code_challenge_methods_supported: { type: 'array', items: { type: 'string' }, example: ['S256'] },
                    device_authorization_endpoint: { type: 'string', example: 'https://id.0g0.xyz/api/device/code' },
                    revocation_endpoint: { type: 'string', example: 'https://id.0g0.xyz/api/token/revoke' },
                    introspection_endpoint: { type: 'string', example: 'https://id.0g0.xyz/api/token/introspect' },
                    claims_supported: { type: 'array', items: { type: 'string' }, example: ['sub', 'iss', 'aud', 'exp', 'iat', 'auth_time', 'nonce', 'name', 'picture', 'email', 'email_verified', 'phone_number', 'address', 'updated_at'] },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/auth/link-intent': {
      post: {
        tags: ['認証フロー'],
        summary: 'SNSプロバイダー連携用ワンタイムトークン発行',
        description:
          '認証済みユーザーに対してSNSプロバイダー連携用のワンタイムトークンを発行する。\n\n' +
          '発行されたトークンは `/auth/login?link_token=<token>` の `link_token` パラメータに使用する。\n\n' +
          'トークンの有効期限は5分。URLパラメータで `link_user_id` を直接受け付けるとアカウント乗っ取りが可能なため、このエンドポイントでアクセストークンで認証したうえでワンタイムトークンを発行する設計。',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'ワンタイム連携トークン',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'object',
                      properties: {
                        link_token: { type: 'string', description: '5分間有効なワンタイムトークン' },
                      },
                      required: ['link_token'],
                    },
                  },
                },
                example: { data: { link_token: 'abc123def456...' } },
              },
            },
          },
          '401': { description: 'UNAUTHORIZED — アクセストークン無効' },
        },
      },
    },
  },
  tags: [
    { name: '認証フロー', description: 'OAuth2.0（Google/LINE/Twitch/GitHub/X）を使ったログイン・トークン管理' },
    { name: 'OIDC', description: 'OIDC Core 1.0 準拠エンドポイント（UserInfo・Discovery）' },
    { name: 'ユーザー API', description: 'ユーザー自身のプロフィール・連携・ログイン履歴管理' },
    { name: 'ユーザー API (管理者)', description: '管理者専用のユーザー管理・ログイン履歴閲覧API' },
    { name: 'サービス管理 API (管理者)', description: '管理者専用のサービス登録・設定・認可ユーザー管理API' },
    { name: '管理者 API', description: '管理者専用のシステム管理API（メトリクス等）' },
    { name: 'トークン', description: 'JWTトークン検証・イントロスペクション・失効' },
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
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'アクセストークン（ES256 JWT、有効期限15分）',
      },
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
    '/auth/authorize': {
      get: {
        tags: ['認証フロー'],
        summary: '標準 OAuth 2.0 / OIDC 認可エンドポイント',
        description:
          'RFC 6749 / RFC 7636 / OIDC Core 1.0 準拠の認可エンドポイント。\n\n' +
          'MCPクライアント・ネイティブアプリ等が直接HTTPリクエストで利用する。\n' +
          'PKCE (S256) 必須。認証後、ユーザーは `redirect_uri` に認可コードとともにリダイレクトされる。\n\n' +
          '```\nGET {redirect_uri}?code=<code>&state=<state>\n```\n\n' +
          '発行された認可コードは `/api/token` (authorization_code grant) で交換する。',
        parameters: [
          {
            name: 'response_type',
            in: 'query',
            required: true,
            schema: { type: 'string', enum: ['code'] },
            description: '`code` 固定（Authorization Code フロー）。',
          },
          {
            name: 'client_id',
            in: 'query',
            required: true,
            schema: { type: 'string', example: 'my_service_client_id' },
            description: '登録済みサービスの `client_id`。',
          },
          {
            name: 'redirect_uri',
            in: 'query',
            required: true,
            schema: { type: 'string', format: 'uri', example: 'https://myapp.com/auth/callback' },
            description: '認可コードのコールバックURL。管理者が登録したURIリストと一致する必要がある。',
          },
          {
            name: 'state',
            in: 'query',
            required: true,
            schema: { type: 'string', example: 'random_csrf_state_value' },
            description: 'CSRF対策用のランダム文字列。コールバック時にそのまま返される。',
          },
          {
            name: 'code_challenge',
            in: 'query',
            required: true,
            schema: { type: 'string', example: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM' },
            description: 'PKCEコードチャレンジ（`code_verifier` をSHA-256でハッシュしBase64urlエンコード）。',
          },
          {
            name: 'code_challenge_method',
            in: 'query',
            required: true,
            schema: { type: 'string', enum: ['S256'] },
            description: 'PKCEメソッド。`S256` のみサポート。',
          },
          {
            name: 'scope',
            in: 'query',
            required: false,
            schema: { type: 'string', example: 'openid profile email' },
            description: 'リクエストするスコープ（スペース区切り）。許可スコープはサービス設定の `allowed_scopes` に制限される。',
          },
          {
            name: 'nonce',
            in: 'query',
            required: false,
            schema: { type: 'string' },
            description: 'IDトークンに埋め込むランダム値（OIDC Core 1.0 §3.1.2.1）。最大128文字。',
          },
        ],
        responses: {
          '302': {
            description:
              'プロバイダー選択ページ（USER_ORIGIN/login）にリダイレクト。ユーザーがプロバイダーを選択後、IdP経由で認証が完了し `redirect_uri?code=<code>&state=<state>` にリダイレクトされる。',
          },
          '400': {
            description: 'invalid_request — パラメータ不正（`client_id` 無効・`redirect_uri` 未登録・PKCEパラメータ不正など）',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/OAuthError' },
                example: { error: 'invalid_request', error_description: 'redirect_uri not registered for this client' },
              },
            },
          },
          '429': {
            description: 'TOO_MANY_REQUESTS — レートリミット超過',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
                example: { error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests. Please try again later.' } },
              },
            },
          },
        },
      },
    },
    '/auth/login': {
      get: {
        tags: ['認証フロー'],
        summary: 'ログイン開始（OAuth 2.0 認可エンドポイント）',
        description:
          'ユーザーのログインフローを開始する。外部サービスはこのURLにユーザーをリダイレクトする。\n\n' +
          '**外部サービスは必ず `client_id` を指定すること。** `client_id` を指定した場合、`redirect_to` は\n' +
          '管理者が登録したリダイレクトURIリストに対して検証される。\n\n' +
          '**PKCE（RFC 7636）推奨**: `code_challenge` / `code_challenge_method=S256` を指定することで、\n' +
          '認可コードの傍受攻撃を防げる。`/auth/exchange` 呼び出し時に対応する `code_verifier` を渡す。\n\n' +
          '認証が完了すると `redirect_to` にワンタイムコードとともにリダイレクトされる:\n' +
          '```\nGET {redirect_to}?code=<ワンタイムコード>&state=<state>\n```',
        parameters: [
          {
            name: 'redirect_to',
            in: 'query',
            required: true,
            schema: { type: 'string', format: 'uri', example: 'https://myapp.com/auth/callback' },
            description:
              '認証後のリダイレクト先URL。`client_id` 指定時は管理者が登録したURIリストと一致する必要がある。HTTPS必須。',
          },
          {
            name: 'state',
            in: 'query',
            required: true,
            schema: { type: 'string', example: 'random_csrf_state_value' },
            description: 'CSRF対策用のランダム文字列。コールバック時にそのまま返される（必ず検証すること）。',
          },
          {
            name: 'client_id',
            in: 'query',
            required: false,
            schema: { type: 'string', example: 'my_service_client_id' },
            description:
              '外部サービスの `client_id`（サービス登録時に発行）。外部サービスは必ず指定すること。未指定の場合は内部BFF向けの検証ロジックが使用される。',
          },
          {
            name: 'provider',
            in: 'query',
            required: false,
            schema: {
              type: 'string',
              enum: ['google', 'line', 'twitch', 'github', 'x'],
              default: 'google',
            },
            description: '使用するOAuthプロバイダー。未指定の場合は `google`。利用可能なプロバイダーはサービス設定により異なる。',
          },
          {
            name: 'scope',
            in: 'query',
            required: false,
            schema: { type: 'string', example: 'openid profile email' },
            description: 'リクエストするスコープ（スペース区切り）。許可スコープはサービス設定の `allowed_scopes` に制限される。',
          },
          {
            name: 'nonce',
            in: 'query',
            required: false,
            schema: { type: 'string' },
            description: 'IDトークン検証用のランダム値（OIDC）。IDトークンの `nonce` クレームとして返される。',
          },
          {
            name: 'code_challenge',
            in: 'query',
            required: false,
            schema: { type: 'string', example: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM' },
            description:
              'PKCEコードチャレンジ（`code_verifier` をSHA-256でハッシュし、Base64urlエンコードした値）。`code_challenge_method=S256` と一緒に指定する。',
          },
          {
            name: 'code_challenge_method',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['S256'] },
            description: 'PKCEのコードチャレンジメソッド。`S256` のみサポート。`code_challenge` 指定時は必須。',
          },
        ],
        responses: {
          '302': {
            description:
              'OAuthプロバイダーの認可画面へリダイレクト。認証完了後、`{redirect_to}?code=<code>&state=<state>` にリダイレクトされる。',
          },
          '400': {
            description: 'BAD_REQUEST — パラメータ不正（`redirect_to` 未登録・`client_id` 無効・PKCEパラメータ不正など）',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
                example: { error: { code: 'BAD_REQUEST', message: 'Invalid redirect_to' } },
              },
            },
          },
          '429': {
            description: 'TOO_MANY_REQUESTS — レートリミット超過',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
                example: { error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests. Please try again later.' } },
              },
            },
          },
        },
      },
    },
    '/auth/exchange': {
      post: {
        tags: ['認証フロー'],
        summary: 'ワンタイムコードをトークンに交換',
        description:
          'ログイン後にコールバックで受け取ったワンタイムコードを、アクセストークン（15分）とリフレッシュトークン（30日）に交換する。\n\n' +
          'このエンドポイントはサーバーサイドから呼び出すこと（コードは1回しか使えない）。\n\n' +
          '`redirect_to` には `/auth/login` に渡したのと同じコールバックURLを指定する。',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  code: { type: 'string', description: 'コールバックで受け取ったワンタイムコード' },
                  redirect_to: { type: 'string', description: 'コールバックURL（/auth/loginに渡したものと一致が必要）' },
                },
                required: ['code', 'redirect_to'],
              },
              example: { code: 'abc123xyz...', redirect_to: 'https://myapp.com/auth/callback' },
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
                  properties: {
                    data: {
                      type: 'object',
                      properties: {
                        access_token: { type: 'string', description: 'JWTアクセストークン（ES256、有効期限15分）' },
                        refresh_token: { type: 'string', description: 'リフレッシュトークン（有効期限30日）' },
                        token_type: { type: 'string', example: 'Bearer' },
                        expires_in: { type: 'integer', example: 900, description: 'アクセストークン有効期限（秒）' },
                        user: {
                          type: 'object',
                          properties: {
                            id: { type: 'string', description: '0g0 ID 内部ユーザーID（External API で使用）' },
                            email: { type: 'string' },
                            name: { type: 'string' },
                            picture: { type: 'string', nullable: true },
                            role: { type: 'string', enum: ['user', 'admin'] },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': { description: 'BAD_REQUEST — コード不正または redirect_to 不一致' },
          '404': { description: 'NOT_FOUND — ユーザー未存在' },
        },
      },
    },
    '/auth/refresh': {
      post: {
        tags: ['認証フロー'],
        summary: 'アクセストークンの更新',
        description:
          'リフレッシュトークンを使って新しいアクセストークンとリフレッシュトークンを発行する（トークンローテーション）。\n\n' +
          '⚠️ **旧リフレッシュトークンは即時無効化される**。必ず新しいリフレッシュトークンを保存すること。\n\n' +
          '同じリフレッシュトークンを2回使った場合（再使用検出）、そのファミリー全体が失効する（セキュリティ機能）。',
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
                  properties: {
                    data: {
                      type: 'object',
                      properties: {
                        access_token: { type: 'string' },
                        refresh_token: { type: 'string', description: '新しいリフレッシュトークン（旧トークンは無効）' },
                        token_type: { type: 'string', example: 'Bearer' },
                        expires_in: { type: 'integer', example: 900 },
                      },
                    },
                  },
                },
              },
            },
          },
          '401': { description: 'UNAUTHORIZED — トークン無効・期限切れ・再使用検出' },
        },
      },
    },
    '/auth/logout': {
      post: {
        tags: ['認証フロー'],
        summary: 'ログアウト',
        description: 'リフレッシュトークンファミリー全体を失効させる。ユーザーのログアウト処理で呼び出すこと。',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  refresh_token: { type: 'string', description: '失効させるリフレッシュトークン（省略時はno-op）' },
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
    '/api/token/introspect': {
      post: {
        tags: ['トークン検証'],
        summary: 'リフレッシュトークンの有効性確認',
        description:
          'RFC 7662 準拠のトークンイントロスペクションエンドポイント。\n\n' +
          'リフレッシュトークンが有効かどうかを確認し、有効な場合はユーザー情報を返す。\n\n' +
          '認証には Basic 認証（`client_id:client_secret`）を使用する。\n\n' +
          '自サービス向けに発行されたトークンのみ照会可能（他サービスのトークンは `active: false`）。',
        security: [{ BasicAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  token: { type: 'string', description: '検証するリフレッシュトークン' },
                },
                required: ['token'],
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'イントロスペクション結果（active: false はトークン無効・期限切れ・他サービス向け）',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    active: { type: 'boolean', description: 'トークンが有効かどうか' },
                    sub: { type: 'string', description: 'ペアワイズユーザー識別子（active: true のみ）' },
                    exp: { type: 'integer', description: '有効期限（Unix timestamp）' },
                    scope: { type: 'string', description: '許可スコープ（スペース区切り）' },
                    name: { type: 'string', description: '表示名（profileスコープ）' },
                    picture: { type: 'string', nullable: true, description: 'プロフィール画像URL（profileスコープ）' },
                    email: { type: 'string', description: 'メールアドレス（emailスコープ）' },
                    email_verified: { type: 'boolean', description: 'メール認証済みフラグ（emailスコープ）' },
                    phone: { type: 'string', nullable: true, description: '電話番号（phoneスコープ）' },
                    address: { type: 'string', nullable: true, description: '住所（addressスコープ）' },
                  },
                  required: ['active'],
                },
                examples: {
                  valid: { value: { active: true, sub: 'a1b2c3...', exp: 1735689600, scope: 'profile email', name: '山田 太郎', email: 'taro@example.com', email_verified: true } },
                  invalid: { value: { active: false } },
                },
              },
            },
          },
          '400': { description: 'BAD_REQUEST — リクエストボディ不正' },
          '401': { description: 'UNAUTHORIZED — Basic 認証失敗' },
        },
      },
    },
    '/.well-known/jwks.json': {
      get: {
        tags: ['JWT検証'],
        summary: 'JWK Set 取得',
        description:
          'JWT署名検証用のES256公開鍵（JWK Set）を返す。\n\n' +
          'アクセストークンの署名をサーバーサイドで検証する場合に使用する。\n\n' +
          'レスポンスは1時間キャッシュ可能（`Cache-Control: public, max-age=3600`）。',
        responses: {
          '200': {
            description: 'JWK Set',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    keys: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          kty: { type: 'string', example: 'EC' },
                          use: { type: 'string', example: 'sig' },
                          crv: { type: 'string', example: 'P-256' },
                          kid: { type: 'string' },
                          x: { type: 'string' },
                          y: { type: 'string' },
                          alg: { type: 'string', example: 'ES256' },
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
    '/api/userinfo': {
      get: {
        tags: ['OIDC'],
        summary: 'UserInfo エンドポイント（OIDC Core 1.0）',
        description:
          'OIDC Core 1.0 Section 5.3 準拠のUserInfoエンドポイント。\n\n' +
          'アクセストークンに付与されたスコープに応じたユーザークレームを返す。\n\n' +
          '| スコープ | 返却クレーム |\n' +
          '|---------|------------|\n' +
          '| `profile` | `name`, `picture` |\n' +
          '| `email` | `email`, `email_verified` |\n' +
          '| `phone` | `phone_number` |\n' +
          '| `address` | `address` |\n\n' +
          '`sub` は常にサービス固有のペアワイズ識別子。',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'スコープに応じたユーザークレーム',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    sub: { type: 'string', description: 'ペアワイズユーザー識別子' },
                    name: { type: 'string', description: '表示名（profileスコープ）' },
                    picture: { type: 'string', nullable: true, description: 'プロフィール画像URL（profileスコープ）' },
                    email: { type: 'string', description: 'メールアドレス（emailスコープ）' },
                    email_verified: { type: 'boolean', description: 'メール認証済み（emailスコープ）' },
                    phone_number: { type: 'string', nullable: true, description: '電話番号（phoneスコープ）' },
                    address: {
                      type: 'object',
                      nullable: true,
                      description: '住所（addressスコープ）',
                      properties: { formatted: { type: 'string' } },
                    },
                    updated_at: { type: 'integer', description: '最終更新日時（Unix timestamp）' },
                  },
                  required: ['sub', 'updated_at'],
                },
                example: {
                  sub: 'pairwise_abc123',
                  name: '山田 太郎',
                  picture: 'https://example.com/photo.jpg',
                  email: 'taro@example.com',
                  email_verified: true,
                  updated_at: 1735689600,
                },
              },
            },
          },
          '401': {
            description: 'UNAUTHORIZED — アクセストークン無効・期限切れ',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string', example: 'invalid_token' },
                    error_description: { type: 'string', example: 'User not found' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/token/revoke': {
      post: {
        tags: ['トークン失効'],
        summary: 'リフレッシュトークン失効（RFC 7009）',
        description:
          'RFC 7009 準拠のトークン失効エンドポイント。\n\n' +
          'リフレッシュトークンを明示的に失効させる。Basic認証（`client_id:client_secret`）が必要。\n\n' +
          '- トークンが存在しない・失効済みの場合も 200 OK を返す（RFC 7009 仕様・情報漏洩防止）\n' +
          '- 自サービスが発行したトークンのみ失効可能（他サービスのトークンは no-op）\n' +
          '- `application/json` と `application/x-www-form-urlencoded` の両形式に対応',
        security: [{ BasicAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { token: { type: 'string', description: '失効させるリフレッシュトークン' } },
                required: ['token'],
              },
            },
            'application/x-www-form-urlencoded': {
              schema: {
                type: 'object',
                properties: { token: { type: 'string', description: '失効させるリフレッシュトークン' } },
                required: ['token'],
              },
            },
          },
        },
        responses: {
          '200': { description: 'OK（失効処理完了またはno-op）' },
          '400': { description: 'BAD_REQUEST — `token` フィールドなし' },
          '401': { description: 'UNAUTHORIZED — Basic認証失敗' },
        },
      },
    },
    '/.well-known/openid-configuration': {
      get: {
        tags: ['OIDC'],
        summary: 'OIDC Discovery Document',
        description:
          'RFC 8414 / OIDC Discovery 1.0 準拠のプロバイダーメタデータ。\n\n' +
          'レスポンスは24時間キャッシュ可能（`Cache-Control: public, max-age=86400`）。',
        responses: {
          '200': {
            description: 'OIDC プロバイダーメタデータ',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    issuer: { type: 'string' },
                    authorization_endpoint: { type: 'string' },
                    token_endpoint: { type: 'string' },
                    jwks_uri: { type: 'string' },
                    userinfo_endpoint: { type: 'string' },
                    introspection_endpoint: { type: 'string' },
                    revocation_endpoint: { type: 'string' },
                    device_authorization_endpoint: { type: 'string' },
                    scopes_supported: { type: 'array', items: { type: 'string' } },
                    response_types_supported: { type: 'array', items: { type: 'string' } },
                    response_modes_supported: { type: 'array', items: { type: 'string' } },
                    grant_types_supported: { type: 'array', items: { type: 'string' } },
                    subject_types_supported: { type: 'array', items: { type: 'string' } },
                    id_token_signing_alg_values_supported: { type: 'array', items: { type: 'string' } },
                    token_endpoint_auth_methods_supported: { type: 'array', items: { type: 'string' } },
                    code_challenge_methods_supported: { type: 'array', items: { type: 'string' } },
                    claims_supported: { type: 'array', items: { type: 'string' } },
                  },
                },
                example: {
                  issuer: 'https://id.0g0.xyz',
                  authorization_endpoint: 'https://id.0g0.xyz/auth/authorize',
                  token_endpoint: 'https://id.0g0.xyz/api/token',
                  jwks_uri: 'https://id.0g0.xyz/.well-known/jwks.json',
                  userinfo_endpoint: 'https://id.0g0.xyz/api/userinfo',
                  introspection_endpoint: 'https://id.0g0.xyz/api/token/introspect',
                  revocation_endpoint: 'https://id.0g0.xyz/api/token/revoke',
                  device_authorization_endpoint: 'https://id.0g0.xyz/api/device/code',
                  scopes_supported: ['openid', 'profile', 'email', 'phone', 'address'],
                  response_types_supported: ['code'],
                  response_modes_supported: ['query'],
                  grant_types_supported: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
                  subject_types_supported: ['pairwise'],
                  id_token_signing_alg_values_supported: ['ES256'],
                  token_endpoint_auth_methods_supported: ['client_secret_basic', 'none'],
                  code_challenge_methods_supported: ['S256'],
                  claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'auth_time', 'nonce', 'name', 'picture', 'email', 'email_verified', 'phone_number', 'address', 'updated_at'],
                },
              },
            },
          },
        },
      },
    },
    '/.well-known/oauth-authorization-server': {
      get: {
        tags: ['OIDC'],
        summary: 'OAuth Authorization Server Metadata',
        description:
          'RFC 8414 準拠の OAuth Authorization Server メタデータ。\n\n' +
          'MCP 仕様で必要とされるエンドポイント情報を返す。\n\n' +
          'レスポンスは24時間キャッシュ可能（`Cache-Control: public, max-age=86400`）。',
        responses: {
          '200': {
            description: 'OAuth Authorization Server メタデータ',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    issuer: { type: 'string' },
                    authorization_endpoint: { type: 'string' },
                    token_endpoint: { type: 'string' },
                    jwks_uri: { type: 'string' },
                    scopes_supported: { type: 'array', items: { type: 'string' } },
                    response_types_supported: { type: 'array', items: { type: 'string' } },
                    response_modes_supported: { type: 'array', items: { type: 'string' } },
                    grant_types_supported: { type: 'array', items: { type: 'string' } },
                    subject_types_supported: { type: 'array', items: { type: 'string' } },
                    token_endpoint_auth_methods_supported: { type: 'array', items: { type: 'string' } },
                    code_challenge_methods_supported: { type: 'array', items: { type: 'string' } },
                    device_authorization_endpoint: { type: 'string' },
                    revocation_endpoint: { type: 'string' },
                    introspection_endpoint: { type: 'string' },
                    claims_supported: { type: 'array', items: { type: 'string' } },
                  },
                },
                example: {
                  issuer: 'https://id.0g0.xyz',
                  authorization_endpoint: 'https://id.0g0.xyz/auth/authorize',
                  token_endpoint: 'https://id.0g0.xyz/api/token',
                  jwks_uri: 'https://id.0g0.xyz/.well-known/jwks.json',
                  scopes_supported: ['openid', 'profile', 'email', 'phone', 'address'],
                  response_types_supported: ['code'],
                  response_modes_supported: ['query'],
                  grant_types_supported: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
                  subject_types_supported: ['pairwise'],
                  token_endpoint_auth_methods_supported: ['client_secret_basic', 'none'],
                  code_challenge_methods_supported: ['S256'],
                  device_authorization_endpoint: 'https://id.0g0.xyz/api/device/code',
                  revocation_endpoint: 'https://id.0g0.xyz/api/token/revoke',
                  introspection_endpoint: 'https://id.0g0.xyz/api/token/introspect',
                  claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'auth_time', 'nonce', 'name', 'picture', 'email', 'email_verified', 'phone_number', 'address', 'updated_at'],
                },
              },
            },
          },
        },
      },
    },
  },
  tags: [
    { name: '認証フロー', description: 'ログイン・トークン交換・更新・ログアウト' },
    { name: 'OIDC', description: 'OIDC Core 1.0 準拠エンドポイント（UserInfo・Discovery）' },
    { name: 'トークン検証', description: 'RFC 7662 トークンイントロスペクション（Basic認証）' },
    { name: 'トークン失効', description: 'RFC 7009 トークン失効（Basic認証）' },
    { name: 'JWT検証', description: 'アクセストークンの署名検証用公開鍵' },
    { name: 'ユーザーデータ取得', description: '連携サービス向けのユーザー情報取得API（Basic認証）' },
  ],
};

// バージョン固定済みのScalar CDN URL（サプライチェーン攻撃リスク低減）
// SRIハッシュはデプロイパイプラインで付与すること
const SCALAR_CDN = 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.49.1';

/**
 * ドキュメントページ（HTML）向けのContent-Security-Policy。
 * Scalar CDNスクリプト読み込みと同一オリジンへのfetchを許可する。
 * securityHeaders()が設定するデフォルトCSP（default-src 'none'）をオーバーライドして使用する。
 */
const DOCS_CSP =
  "default-src 'none'; " +
  `script-src ${SCALAR_CDN}; ` +
  "connect-src 'self'; " +
  "style-src 'unsafe-inline'; " +
  "font-src 'self' data: https:; " +
  "img-src 'self' data: https:; " +
  "worker-src blob:; " +
  "frame-ancestors 'none'";

// ─── OpenAPI → Markdown 変換 ─────────────────────────────────────────
type OpenApiOperation = {
  tags?: string[];
  summary?: string;
  description?: string;
  parameters?: Array<{ name: string; in: string; required?: boolean; description?: string; schema?: { type?: string; enum?: string[] } }>;
  requestBody?: { required?: boolean; content?: Record<string, { schema?: unknown }> };
  responses?: Record<string, { description?: string }>;
  security?: Array<Record<string, unknown>>;
};

type OpenApiSpec = {
  info: { title: string; description?: string };
  paths: Record<string, Record<string, OpenApiOperation>>;
};

/**
 * OpenAPI 仕様オブジェクトをAI/人間が読みやすいMarkdownに変換する。
 * JSなしで参照可能な /docs/external.md / /docs/openapi.md エンドポイント向け。
 */
function openApiToMarkdown(spec: OpenApiSpec, htmlUrl?: string): string {
  const lines: string[] = [];
  lines.push(`# ${spec.info.title}`);
  lines.push('');
  if (htmlUrl) {
    lines.push(`> インタラクティブ版（Swagger UI）: [${htmlUrl}](${htmlUrl})`);
    lines.push('');
  }
  if (spec.info.description) {
    lines.push(spec.info.description);
    lines.push('');
  }

  // pathsをtagでグループ化
  const byTag: Record<string, Array<{ path: string; method: string; op: OpenApiOperation }>> = {};
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const tags = op.tags ?? ['その他'];
      for (const tag of tags) {
        if (!byTag[tag]) byTag[tag] = [];
        byTag[tag].push({ path, method, op });
      }
    }
  }

  for (const [tag, ops] of Object.entries(byTag)) {
    lines.push(`## ${tag}`);
    lines.push('');
    for (const { path, method, op } of ops) {
      lines.push(`### ${method.toUpperCase()} ${path}`);
      lines.push('');
      if (op.summary) {
        lines.push(`**${op.summary}**`);
        lines.push('');
      }
      if (op.description) {
        lines.push(op.description);
        lines.push('');
      }
      if (op.security) {
        const schemes = op.security.flatMap((s) => Object.keys(s));
        if (schemes.length > 0) {
          lines.push(`**認証**: ${schemes.join(', ')}`);
          lines.push('');
        }
      }
      if (op.parameters && op.parameters.length > 0) {
        lines.push('**パラメータ**');
        lines.push('');
        lines.push('| 名前 | 場所 | 必須 | 型 | 説明 |');
        lines.push('|------|------|------|----|------|');
        for (const p of op.parameters) {
          const required = p.required ? '✓' : '';
          const type = p.schema?.enum ? p.schema.enum.map((v) => `\`${v}\``).join(' | ') : (p.schema?.type ?? '');
          const desc = (p.description ?? '').replace(/\n/g, ' ');
          lines.push(`| \`${p.name}\` | ${p.in} | ${required} | ${type} | ${desc} |`);
        }
        lines.push('');
      }
      if (op.responses) {
        lines.push('**レスポンス**');
        lines.push('');
        for (const [status, resp] of Object.entries(op.responses)) {
          lines.push(`- **${status}**: ${resp.description ?? ''}`);
        }
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

// ─── Scalar HTML テンプレート ────────────────────────────────────────
function scalarHtml(specUrl: string, title: string, markdownUrl: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    #ai-link { position: fixed; bottom: 16px; right: 16px; z-index: 9999; background: #1a1a1a; color: #fff; padding: 6px 12px; border-radius: 6px; font-size: 12px; text-decoration: none; font-family: sans-serif; opacity: 0.8; }
    #ai-link:hover { opacity: 1; }
  </style>
</head>
<body>
  <a id="ai-link" href="${markdownUrl}">📄 Markdown版 (AI向け)</a>
  <script id="api-reference" data-url="${specUrl}"></script>
  <script src="${SCALAR_CDN}" crossorigin="anonymous"></script>
</body>
</html>`;
}

// ─── ルート定義 ────────────────────────────────────────────────────
// IdP 開発者向け: 全API（内部利用）
app.get('/', (c) => {
  c.header('Content-Security-Policy', DOCS_CSP);
  return c.html(scalarHtml('/docs/openapi.json', '0g0 ID API — IdP 開発者向け', '/docs/openapi.md'));
});
// 内部向け仕様は開発者ネットワーク内での参照を想定。本番では Cloudflare Access 等で保護すること
app.get('/openapi.json', (c) => c.json(INTERNAL_OPENAPI));
// AI・CLIツール向けMarkdown版（JSなしで参照可能）
app.get('/openapi.md', (c) => {
  c.header('Content-Type', 'text/markdown; charset=utf-8');
  return c.body(openApiToMarkdown(INTERNAL_OPENAPI as OpenApiSpec, 'https://id.0g0.xyz/docs'));
});

// 外部連携サービス向け: 外部API + 連携フロー
app.get('/external', (c) => {
  c.header('Content-Security-Policy', DOCS_CSP);
  return c.html(scalarHtml('/docs/external/openapi.json', '0g0 ID API — 外部連携サービス向け', '/docs/external.md'));
});
app.get('/external/openapi.json', (c) => c.json(EXTERNAL_OPENAPI));
// AI・CLIツール向けMarkdown版（JSなしで参照可能）
app.get('/external.md', (c) => {
  c.header('Content-Type', 'text/markdown; charset=utf-8');
  return c.body(openApiToMarkdown(EXTERNAL_OPENAPI as OpenApiSpec, 'https://id.0g0.xyz/docs/external'));
});

export default app;

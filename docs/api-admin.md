# admin Worker BFF API 仕様書

**ベースURL**: `https://admin.0g0.xyz`
**役割**: 管理者向け BFF（サービス管理 / ユーザー管理 / メトリクス / 監査ログ） + Astro SPA 配信
**ソース**: `workers/admin/src/index.ts` および `workers/admin/src/routes/*.ts`

## 認証・セキュリティ

- **セッション Cookie**: `__Host-admin-session`（HS256 署名、`access_token` / `refresh_token` / `user` を含む）
- **OAuth state Cookie**: `__Host-admin-oauth-state`
- **ロール検証**: `/api/*` すべてに管理者ロールミドルウェアを適用。`role !== "admin"` ならセッション Cookie を削除して 403。多層防御（IdP 側での降格も早期拒否）。
- **CSRF**: `/api/*` / `/auth/logout` に `bffCsrfMiddleware`。`/auth/dbsc/*` は Chrome 内部発のフローで Origin ヘッダが付かないため除外し、Cookie セッション + 自署 JWT (audience=SELF_ORIGIN) + bff_origin 一致確認の多層で防御。
- **DBSC（Phase 1）**: ログイン callback 応答に `Secure-Session-Registration: (ES256);path="/auth/dbsc/start"` を付与。Chrome は端末公開鍵で自署した登録 JWT を `/auth/dbsc/start` に送り、bff_sessions に紐付ける。Phase 1 はバインド記録のみ（短寿命 Cookie・チャレンジは Phase 2）。
- **CORS**: `/api/*` は自身のオリジンのみ許可
- **UUID 検証**: `:id` / `:userId` / `:tokenId` / `:uriId` などすべてのパスパラメータを UUID 形式で検証（不正なら 400）

## 認証フロー（`/auth/*`）

`createBffAuthRoutes()` 共通ルート。詳細は `packages/shared/src/routes/auth-routes.ts` を参照。

| Method | Path               | 認証              | 説明                                                                                                                   |
| ------ | ------------------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| GET    | `/auth/login`      | —                 | id Worker `/auth/login` へリダイレクト                                                                                 |
| GET    | `/auth/callback`   | —                 | ワンタイムコード交換・セッション Cookie 発行。`Secure-Session-Registration` ヘッダで DBSC 登録を Chrome に開始させる   |
| POST   | `/auth/logout`     | セッション Cookie | リフレッシュトークン失効・Cookie 削除                                                                                  |
| POST   | `/auth/dbsc/start` | セッション Cookie | DBSC 端末公開鍵バインド。Body は `application/jwt` または `{ "jwt": "..." }`。検証成功で `bff_sessions` に公開鍵保存。 |

管理者画面はログイン後にロール検証が走るため、非 admin ユーザーは即 403 で弾かれる。

### `POST /auth/dbsc/start` の応答

成功時 200:

```json
{
  "session_identifier": "<bff_sessions.id>",
  "refresh_url": "/auth/dbsc/refresh",
  "scope": { "include_site": true },
  "credentials": [{ "type": "cookie", "name": "__Host-admin-session" }]
}
```

エラー: 401 `UNAUTHORIZED`（Cookie なし）、400 `INVALID_REQUEST` / `INVALID_JWT`（JWT 検証失敗・既バインド・列挙対策で 4xx は一律畳み込み）、500 `INTERNAL_ERROR`（IdP 障害）。

## サービス管理（`/api/services/*`）

| Method | Path                                     | 転送先 (id)                       | 用途                                               |
| ------ | ---------------------------------------- | --------------------------------- | -------------------------------------------------- |
| GET    | `/api/services`                          | `/api/services`                   | サービス一覧（`limit` / `offset` / `name`）        |
| POST   | `/api/services`                          | `/api/services`                   | サービス新規作成（client_id / client_secret 発行） |
| GET    | `/api/services/:id`                      | `/api/services/:id`               | サービス詳細                                       |
| PATCH  | `/api/services/:id`                      | `/api/services/:id`               | 名称 / allowed_scopes 更新                         |
| DELETE | `/api/services/:id`                      | `/api/services/:id`               | サービス削除                                       |
| POST   | `/api/services/:id/rotate-secret`        | `/api/services/:id/rotate-secret` | client_secret 再発行                               |
| PATCH  | `/api/services/:id/owner`                | `/api/services/:id/owner`         | オーナー変更                                       |
| GET    | `/api/services/:id/redirect-uris`        | 同左                              | リダイレクト URI 一覧                              |
| POST   | `/api/services/:id/redirect-uris`        | 同左                              | リダイレクト URI 追加                              |
| DELETE | `/api/services/:id/redirect-uris/:uriId` | 同左                              | リダイレクト URI 削除                              |
| GET    | `/api/services/:id/users`                | `/api/services/:id/users`         | 認可済みユーザー一覧（`limit` / `offset`）         |
| DELETE | `/api/services/:id/users/:userId`        | 同左                              | ユーザーのサービスアクセス失効                     |

## ユーザー管理（`/api/users/*`）

| Method | Path                             | 転送先 (id)                     | 用途                                                              |
| ------ | -------------------------------- | ------------------------------- | ----------------------------------------------------------------- |
| GET    | `/api/users`                     | `/api/users`                    | 一覧（`limit` / `offset` / `email` / `role` / `name` / `banned`） |
| GET    | `/api/users/:id`                 | `/api/users/:id`                | ユーザー詳細                                                      |
| DELETE | `/api/users/:id`                 | `/api/users/:id`                | ユーザー削除                                                      |
| PATCH  | `/api/users/:id/role`            | `/api/users/:id/role`           | ロール変更                                                        |
| PATCH  | `/api/users/:id/ban`             | `/api/users/:id/ban`            | BAN                                                               |
| DELETE | `/api/users/:id/ban`             | `/api/users/:id/ban`            | BAN 解除                                                          |
| GET    | `/api/users/:id/owned-services`  | `/api/users/:id/owned-services` | 所有サービス                                                      |
| GET    | `/api/users/:id/services`        | `/api/users/:id/services`       | 認可中サービス                                                    |
| GET    | `/api/users/:id/providers`       | `/api/users/:id/providers`      | 連携プロバイダー                                                  |
| GET    | `/api/users/:id/login-history`   | 同左                            | ログイン履歴（`limit` / `offset` / `provider`）                   |
| GET    | `/api/users/:id/login-stats`     | `/api/users/:id/login-stats`    | プロバイダー別統計（`days`）                                      |
| GET    | `/api/users/:id/login-trends`    | `/api/users/:id/login-trends`   | 日別トレンド（`days`）                                            |
| GET    | `/api/users/:id/tokens`          | `/api/users/:id/tokens`         | アクティブセッション一覧                                          |
| DELETE | `/api/users/:id/tokens`          | 同左                            | 全セッション失効                                                  |
| DELETE | `/api/users/:id/tokens/:tokenId` | 同左                            | 個別セッション失効                                                |
| GET    | `/api/users/:id/bff-sessions`    | `/api/users/:id/bff-sessions`   | BFF セッション一覧（DBSC バインド状態 `has_device_key` 含む）     |

## メトリクス（`/api/metrics/*`）

| Method | Path                              | 転送先 (id)    | 用途                                                    |
| ------ | --------------------------------- | -------------- | ------------------------------------------------------- |
| GET    | `/api/metrics`                    | `/api/metrics` | 総合メトリクス                                          |
| GET    | `/api/metrics/login-trends`       | 同左           | 日別ログイントレンド（`days`）                          |
| GET    | `/api/metrics/services`           | 同左           | サービス別アクティブトークン統計                        |
| GET    | `/api/metrics/suspicious-logins`  | 同左           | 不審ログイン（`hours` 1〜720 / `min_countries` 1〜100） |
| GET    | `/api/metrics/user-registrations` | 同左           | 日別新規ユーザー登録数（`days`）                        |
| GET    | `/api/metrics/active-users`       | 同左           | DAU / WAU / MAU                                         |
| GET    | `/api/metrics/active-users/daily` | 同左           | 日別アクティブユーザー（`days`）                        |

## 監査ログ（`/api/audit-logs`）

| Method | Path              | 転送先 (id)             | 用途                                                                                                        |
| ------ | ----------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| GET    | `/api/audit-logs` | `/api/admin/audit-logs` | 管理者操作ログ（`limit` / `offset` / `admin_user_id` UUID / `target_id` UUID / `action` `[a-z]+\.[a-z_]+`） |

## ヘルスチェック・フォールバック

| Method | Path          | 説明                                                                                                                               |
| ------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/health` | `{ status: "ok", worker: "admin", timestamp }`                                                                                     |
| GET    | `/api/*`      | 未定義 GET は 404（SPA fallback に流さない）                                                                                       |
| GET    | `*`           | Astro ビルド済み HTML を `ASSETS` から配信。動的 UUID パス（例: `/users/:uuid`）は自動的に `/users/detail/index.html` にリライト。 |

## エラーフォーマット

id Worker と同一の `{ error: { code, message } }` 形式。ミドルウェア由来の代表コード: `UNAUTHORIZED`（セッションなし）、`FORBIDDEN`（非 admin）、`BAD_REQUEST`（UUID 形式不正）、`INVALID_PARAMETER`（数値パラメータ範囲外）、`INTERNAL_ERROR`。

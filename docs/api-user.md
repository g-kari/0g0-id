# user Worker BFF API 仕様書

**ベースURL**: `https://user.0g0.xyz`
**役割**: ユーザー向け BFF（ログイン UI / プロフィール / セッション管理） + Astro SPA 配信
**ソース**: `workers/user/src/index.ts` および `workers/user/src/routes/*.ts`

## 認証・セキュリティ

- **セッション Cookie**: `__Host-user-session`（HS256 署名付き、`access_token` / `refresh_token` / `user_id` を含む）
- **OAuth state Cookie**: `__Host-user-oauth-state`（CSRF 対策ワンタイム）
- **内部通信**: id Worker へは Service Binding (`c.env.IDP.fetch`) で呼び出し、`internalServiceHeaders()` を付与
- **CSRF 対策**: `/api/*` / `/auth/logout` / `/auth/link` に `bffCsrfMiddleware`（Origin/Referer 検証）
- **CORS**: `/api/*` は自身のオリジン (`user.0g0.xyz`) のみ許可
- **レスポンス透過**: id Worker からのレスポンスは `proxyResponse()` / `proxyMutate()` でそのままクライアントに返す

## 認証フロー（`/auth/*`）

`createBffAuthRoutes()` が生成する共通ルート + 独自の `/auth/link`。

| Method | Path             | 認証              | 説明                                                                                                                                                                       |
| ------ | ---------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/auth/login`    | —                 | `provider` クエリでプロバイダーを選択し、id Worker `/auth/login` にリダイレクト。                                                                                          |
| GET    | `/auth/callback` | —                 | id Worker からのコールバック。ワンタイムコードを `/auth/exchange` で交換し、セッション Cookie を発行して `/profile` へ。                                                   |
| POST   | `/auth/logout`   | セッション Cookie | リフレッシュトークンを失効させ、セッション Cookie を削除。                                                                                                                 |
| POST   | `/auth/link`     | セッション Cookie | ログイン済みユーザーの SNS プロバイダー追加連携。内部で `link-intent` トークンを取得し、`/auth/login?link_token=...` へリダイレクト。POST 固定（強制ナビゲーション対策）。 |

## OAuth / OIDC プロバイダー選択（`/login`）

| Method | Path     | 用途                                                                                                                                                                                                                             |
| ------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/login` | id Worker の `/auth/authorize` からリダイレクトされる外部クライアント向けプロバイダー選択ページ。Google / LINE / Twitch / GitHub / X の 5 ボタンを表示し、選択後は直接 id Worker `/auth/login` に遷移（PKCE パラメータを保持）。 |

## プロフィール API（`/api/me/*`）

全エンドポイントで `__Host-user-session` 必須。id Worker の対応エンドポイントへプロキシ。

| Method | Path                       | 転送先 (id)                      | 用途                                            |
| ------ | -------------------------- | -------------------------------- | ----------------------------------------------- |
| GET    | `/api/me`                  | `/api/users/me`                  | 自分のプロフィール取得                          |
| PATCH  | `/api/me`                  | `/api/users/me`                  | プロフィール更新                                |
| DELETE | `/api/me`                  | `/api/users/me`                  | 退会（204 で Cookie も削除）                    |
| GET    | `/api/me/login-history`    | `/api/users/me/login-history`    | ログイン履歴（`limit` / `offset` / `provider`） |
| GET    | `/api/me/login-stats`      | `/api/users/me/login-stats`      | プロバイダー別ログイン統計（`days`）            |
| GET    | `/api/me/data-export`      | `/api/users/me/data-export`      | アカウントデータ一括エクスポート                |
| GET    | `/api/me/security-summary` | `/api/users/me/security-summary` | セキュリティサマリ                              |

## セキュリティ API（`/api/me/security/*`）

| Method | Path                            | 転送先 (id)                      | 用途                       |
| ------ | ------------------------------- | -------------------------------- | -------------------------- |
| GET    | `/api/me/security/summary`      | `/api/users/me/security-summary` | セキュリティ概要           |
| GET    | `/api/me/security/login-stats`  | `/api/users/me/login-stats`      | プロバイダー別ログイン統計 |
| GET    | `/api/me/security/login-trends` | `/api/users/me/login-trends`     | 日別ログイントレンド       |

## セッション管理（`/api/me/sessions/*`）

| Method | Path                          | 転送先 (id)                       | 用途                                                                               |
| ------ | ----------------------------- | --------------------------------- | ---------------------------------------------------------------------------------- |
| GET    | `/api/me/sessions`            | `/api/users/me/tokens`            | アクティブセッション一覧                                                           |
| DELETE | `/api/me/sessions/others`     | `/api/users/me/tokens/others`     | 現在のセッション以外をすべて終了（現在の refresh_token の SHA-256 ハッシュを送信） |
| DELETE | `/api/me/sessions/:sessionId` | `/api/users/me/tokens/:sessionId` | 特定セッションを終了（UUID 形式検証）                                              |
| DELETE | `/api/me/sessions`            | `/api/users/me/tokens`            | 全デバイスからログアウト                                                           |

## 連携サービス（`/api/connections/*`）

| Method | Path                          | 転送先 (id)                            | 用途                          |
| ------ | ----------------------------- | -------------------------------------- | ----------------------------- |
| GET    | `/api/connections`            | `/api/users/me/connections`            | 連携済みサービス一覧          |
| DELETE | `/api/connections/:serviceId` | `/api/users/me/connections/:serviceId` | サービス連携解除（UUID 検証） |

## SNS プロバイダー管理（`/api/providers/*`）

| Method | Path                       | 転送先 (id)                         | 用途                             |
| ------ | -------------------------- | ----------------------------------- | -------------------------------- |
| GET    | `/api/providers`           | `/api/users/me/providers`           | 連携済み・未連携プロバイダー一覧 |
| DELETE | `/api/providers/:provider` | `/api/users/me/providers/:provider` | 連携解除（最後の 1 件は 409）    |

## ログイン履歴（`/api/login-history`）

| Method | Path                 | 転送先 (id)                   | 用途                                            |
| ------ | -------------------- | ----------------------------- | ----------------------------------------------- |
| GET    | `/api/login-history` | `/api/users/me/login-history` | ログイン履歴（`limit` / `offset` / `provider`） |

## Device Authorization Grant（`/api/device/*`）

| Method | Path                  | 転送先 (id)                           | 用途                                         |
| ------ | --------------------- | ------------------------------------- | -------------------------------------------- |
| POST   | `/api/device/verify`  | `/api/device/verify`                  | ユーザーコード検証（形式: `XXXX-XXXX`）      |
| POST   | `/api/device/approve` | `/api/device/verify`（`action` 付与） | 承認 / 拒否（`action: "approve" \| "deny"`） |

## ヘルスチェック・フォールバック

| Method | Path          | 説明                                                                                    |
| ------ | ------------- | --------------------------------------------------------------------------------------- |
| GET    | `/api/health` | `{ status: "ok", worker: "user", timestamp }`                                           |
| GET    | `/api/*`      | その他 API ルートは 404 を返す（SPA fallback に流さない）                               |
| GET    | `*`           | 上記以外は Astro ビルド済み HTML を `ASSETS` から配信（MPA ディレクトリルーティング）。 |

## エラーフォーマット

id Worker と同じ `{ error: { code, message } }` 形式。BFF 固有の追加コード: `UPSTREAM_ERROR`（id Worker 到達失敗）、`INTERNAL_ERROR`（予期せぬ例外）。

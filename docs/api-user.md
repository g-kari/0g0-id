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

RFC 8628 に準拠したデバイスフロー（スマート TV・CLI・IoT 端末など、ブラウザを直接操作できないクライアント向け）。  
BFF（user.0g0.xyz）は **ユーザー端末側（承認 UI）** のみを担当し、`/api/device/code` と `/api/device/token` は IdP（id.0g0.xyz）で直接提供する。

| Method | Path                  | 転送先 (id)                           | 用途                                         |
| ------ | --------------------- | ------------------------------------- | -------------------------------------------- |
| POST   | `/api/device/verify`  | `/api/device/verify`                  | ユーザーコード検証（形式: `XXXX-XXXX`）      |
| POST   | `/api/device/approve` | `/api/device/verify`（`action` 付与） | 承認 / 拒否（`action: "approve" \| "deny"`） |

### ユーザーコード仕様

- 形式: `XXXX-XXXX`（ハイフン区切りの 8 文字）
- アルファベット: `ABCDEFGHJKMNPQRSTUVWXYZ23456789`（31 文字／紛らわしい `O / 0 / I / 1 / L` を除外）
- 大文字小文字: 入力は大文字小文字・ハイフン・空白を無視して正規化（例: `abcd ef34` → `ABCDEF34` として扱う）
- 有効期限: **600 秒（10 分）**。過ぎると `CODE_EXPIRED` 400 を返す
- ポーリング間隔: デバイス側トークン取得は `5 秒` ごと。承認前の polling は `authorization_pending`、レート超過は `slow_down`（どちらも id 側の `/api/token` で返す）

### フロー概要

```
[デバイス]                         [ユーザー端末 (user.0g0.xyz)]                  [IdP (id.0g0.xyz)]
    │                                          │                                           │
    │  POST /api/device/code                   │                                           │
    ├─────────────────────────────────────────────────────────────────────────────────────▶│
    │                                          │                                           │
    │◀─ { device_code, user_code, verification_uri, expires_in: 600, interval: 5 } ───────┤
    │                                          │                                           │
    │  ユーザーに verification_uri と user_code を提示                                      │
    │                                          │                                           │
    │                               ユーザーがブラウザで /device へアクセス                 │
    │                                          │                                           │
    │                               POST /api/device/verify { user_code }                  │
    │                               (セッション Cookie で認証)                              │
    │                                          ├──────────────────────────────────────────▶│
    │                                          │◀─ { data: { service_name, scopes } }     │
    │                                          │                                           │
    │                               POST /api/device/approve { user_code, action }         │
    │                                          ├──────────────────────────────────────────▶│
    │                                          │◀─ { status: "approved" | "denied" }      │
    │                                          │                                           │
    │  POST /api/device/token { device_code, grant_type, client_id } を interval 秒ごとに    │
    ├─────────────────────────────────────────────────────────────────────────────────────▶│
    │◀─ access_token + refresh_token（承認後）／ authorization_pending（承認前）             │
```

### POST `/api/device/verify`（情報取得）

ユーザーコードの妥当性を確認し、連携先サービス名と要求スコープを返す。**action を付けない**のがこのエンドポイントの役割。

**リクエスト**

```http
POST /api/device/verify
Content-Type: application/json
Cookie: __Host-session=...
```

```json
{ "user_code": "ABCD-EF34" }
```

| フィールド  | 型     | 必須 | 説明                                                                     |
| ----------- | ------ | ---- | ------------------------------------------------------------------------ |
| `user_code` | string | ○    | `XXXX-XXXX` 形式。小文字・空白・ハイフン揺れは許容（サーバ側で正規化）。 |

**成功レスポンス（200）**

```json
{
  "data": {
    "service_name": "example-cli",
    "scopes": ["openid", "profile", "email"]
  }
}
```

### POST `/api/device/approve`（承認 / 拒否）

確認済みの user_code に対して承認または拒否を送る。

**リクエスト**

```http
POST /api/device/approve
Content-Type: application/json
Cookie: __Host-session=...
```

```json
{ "user_code": "ABCD-EF34", "action": "approve" }
```

| フィールド  | 型                      | 必須 | 説明                                |
| ----------- | ----------------------- | ---- | ----------------------------------- |
| `user_code` | string                  | ○    | `XXXX-XXXX` 形式。                  |
| `action`    | `"approve"` \| `"deny"` | ○    | 他の値は `BAD_REQUEST` 400 を返す。 |

**成功レスポンス（200）**

```json
{ "status": "approved" }
```

または

```json
{ "status": "denied" }
```

### エラーレスポンス（`/api/device/verify`・`/api/device/approve` 共通）

BFF 経由で返るエラーは `{ error: { code, message } }` 形式。

| HTTP | code                | 条件                                                    |
| ---- | ------------------- | ------------------------------------------------------- |
| 400  | `BAD_REQUEST`       | JSON パース失敗 / `user_code` 形式違反 / `action` 不正  |
| 400  | `CODE_EXPIRED`      | `user_code` が 600 秒の有効期限を過ぎた                 |
| 400  | `CODE_ALREADY_USED` | すでに承認 / 拒否済みの `user_code`                     |
| 401  | `UNAUTHORIZED`      | セッション Cookie なし・無効・期限切れ                  |
| 404  | `INVALID_CODE`      | 未知の `user_code`（存在しないか掃除済み）              |
| 429  | `TOO_MANY_REQUESTS` | レートリミット超過（`deviceVerifyRateLimitMiddleware`） |
| 502  | `UPSTREAM_ERROR`    | IdP に到達できない                                      |
| 500  | `INTERNAL_ERROR`    | サーバ側例外                                            |

### 実装参照

- BFF: `workers/user/src/routes/device.ts`
- IdP: `workers/id/src/routes/device.ts`（`/api/device/code`・`/api/device/verify`・`/api/device/token`）
- 仕様: RFC 8628 — OAuth 2.0 Device Authorization Grant

## ヘルスチェック・フォールバック

| Method | Path          | 説明                                                                                    |
| ------ | ------------- | --------------------------------------------------------------------------------------- |
| GET    | `/api/health` | `{ status: "ok", worker: "user", timestamp }`                                           |
| GET    | `/api/*`      | その他 API ルートは 404 を返す（SPA fallback に流さない）                               |
| GET    | `*`           | 上記以外は Astro ビルド済み HTML を `ASSETS` から配信（MPA ディレクトリルーティング）。 |

## エラーフォーマット

id Worker と同じ `{ error: { code, message } }` 形式。BFF 固有の追加コード: `UPSTREAM_ERROR`（id Worker 到達失敗）、`INTERNAL_ERROR`（予期せぬ例外）。

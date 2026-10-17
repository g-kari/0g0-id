# MCP Server — 0g0-id 管理用 MCP Worker

`mcp.0g0.xyz` は、0g0-id 統合ID基盤の管理操作を [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) 経由で提供するサーバーです。Claude Code 等の MCP 対応クライアントから、ユーザー管理・サービス管理・メトリクス取得などの管理操作を実行できます。

## 接続情報

| 項目                 | 値                                      |
| -------------------- | --------------------------------------- |
| エンドポイント       | `https://mcp.0g0.xyz/mcp`               |
| プロトコル           | MCP over Streamable HTTP (JSON-RPC 2.0) |
| プロトコルバージョン | `2025-03-26`                            |
| 認証                 | Bearer Token (ES256 JWT)                |
| 管理者ロール         | 必須                                    |
| レートリミット       | 60 req/min                              |

## 認証

### Bearer Token

すべての MCP リクエストには `Authorization: Bearer <token>` ヘッダーが必要です。

トークンは 0g0-id IdP (`id.0g0.xyz`) が発行する ES256 署名の JWT アクセストークンです。MCP サーバーは IdP の JWKS エンドポイント (`id.0g0.xyz/.well-known/jwks.json`) から公開鍵を取得して署名を検証します。

### 要件

- **管理者ロール**: `role: "admin"` のトークンのみ許可（403 Forbidden）
- **BAN チェック**: BAN 済みユーザーは拒否（401 Unauthorized）
- **jti 必須**: トークンに `jti` クレームが必要（リボーク対応）
- **リボーク検証**: リボーク済みトークンは即時拒否

### Protected Resource Metadata (RFC 9728)

```
GET https://mcp.0g0.xyz/.well-known/oauth-protected-resource
```

```json
{
  "resource": "https://mcp.0g0.xyz",
  "authorization_servers": ["https://id.0g0.xyz"],
  "scopes_supported": ["openid", "profile", "email"],
  "bearer_methods_supported": ["header"]
}
```

## トランスポート

MCP over Streamable HTTP を採用しています。

### セッション管理

| メソッド | パス   | 説明                                          |
| -------- | ------ | --------------------------------------------- |
| `POST`   | `/mcp` | JSON-RPC リクエスト処理                       |
| `GET`    | `/mcp` | SSE ストリーム（サーバー→クライアント通知用） |
| `DELETE` | `/mcp` | セッション終了                                |

#### セッションの流れ

1. **初期化**: `POST /mcp` に `initialize` メソッドを送信 → レスポンスヘッダー `Mcp-Session-Id` でセッション ID を取得
2. **ツール呼び出し**: 以降のリクエストには `Mcp-Session-Id` ヘッダーを付与
3. **終了**: `DELETE /mcp` でセッション破棄

セッションにはアイドルタイムアウト（スライディングウィンドウ）が設定されています。

### バッチリクエスト

JSON-RPC のバッチリクエスト（配列形式）に対応しています。

```json
[
  { "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "list_users" } },
  { "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "get_system_metrics" } }
]
```

## Claude Code での設定

`.claude/settings.json` に以下を追加します:

```json
{
  "mcpServers": {
    "0g0-id": {
      "type": "url",
      "url": "https://mcp.0g0.xyz/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_ACCESS_TOKEN>"
      }
    }
  }
}
```

> **注意**: アクセストークンは有効期限 15 分のため、定期的な更新が必要です。BFF 経由のセッション Cookie を使用する場合は、別途トークン取得の仕組みが必要です。

## ツール一覧

### ユーザー管理 (14 tools)

| ツール名                       | 説明                                                 | 必須パラメータ    | 任意パラメータ                        |
| ------------------------------ | ---------------------------------------------------- | ----------------- | ------------------------------------- |
| `list_users`                   | ユーザー一覧を取得する（ページネーション・検索対応） | —                 | `page?`, `limit?`, `search?`, `role?` |
| `get_user`                     | 指定ユーザーの詳細情報を取得する                     | `user_id`         | —                                     |
| `ban_user`                     | ユーザーを BAN する                                  | `user_id`         | —                                     |
| `unban_user`                   | ユーザーの BAN を解除する                            | `user_id`         | —                                     |
| `delete_user`                  | ユーザーを削除する（取り消し不可）                   | `user_id`         | —                                     |
| `update_user_role`             | ユーザーのロールを変更する（user ↔ admin）           | `user_id`, `role` | —                                     |
| `get_user_login_history`       | ユーザーのログイン履歴を取得する                     | `user_id`         | `limit?`                              |
| `get_user_login_stats`         | ユーザーのプロバイダー別ログイン統計を取得する       | `user_id`         | `days?`                               |
| `get_user_login_trends`        | ユーザーの日別ログイントレンドを取得する             | `user_id`         | `days?`                               |
| `get_user_providers`           | ユーザーの連携済みプロバイダー一覧を取得する         | `user_id`         | —                                     |
| `list_user_sessions`           | ユーザーのアクティブセッション一覧を取得する         | `user_id`         | —                                     |
| `revoke_user_sessions`         | ユーザーの全セッションを失効させる（強制ログアウト） | `user_id`         | —                                     |
| `get_user_owned_services`      | ユーザーが所有するサービス一覧を取得する             | `user_id`         | —                                     |
| `get_user_authorized_services` | ユーザーが認可済みのサービス一覧を取得する           | `user_id`         | —                                     |

### サービス管理 (12 tools)

| ツール名                     | 説明                                                              | 必須パラメータ                    | 任意パラメータ             |
| ---------------------------- | ----------------------------------------------------------------- | --------------------------------- | -------------------------- |
| `list_services`              | サービス一覧を取得する（ページネーション・検索対応）              | —                                 | `page?`, `limit?`, `name?` |
| `get_service`                | サービスの詳細情報を取得する                                      | `service_id`                      | —                          |
| `create_service`             | 新規サービスを登録する（client_secret は作成時のみ返却）          | `name`                            | `allowed_scopes?`          |
| `update_service`             | サービスの名前または許可スコープを更新する                        | `service_id`                      | `name?`, `allowed_scopes?` |
| `delete_service`             | サービスを削除する（取り消し不可）                                | `service_id`                      | —                          |
| `rotate_service_secret`      | クライアントシークレットをローテーションする（再取得不可）        | `service_id`                      | —                          |
| `list_redirect_uris`         | リダイレクト URI 一覧を取得する                                   | `service_id`                      | —                          |
| `add_redirect_uri`           | リダイレクト URI を追加する（HTTPS 必須、localhost のみ HTTP 可） | `service_id`, `uri`               | —                          |
| `delete_redirect_uri`        | リダイレクト URI を削除する                                       | `service_id`, `uri_id`            | —                          |
| `list_service_users`         | サービスを認可済みのユーザー一覧を取得する                        | `service_id`                      | `page?`, `limit?`          |
| `revoke_service_user_access` | ユーザーのサービスアクセスを失効させる                            | `service_id`, `user_id`           | —                          |
| `transfer_service_ownership` | サービスの所有権を別ユーザーに転送する                            | `service_id`, `new_owner_user_id` | —                          |

### 監査ログ (2 tools)

| ツール名          | 説明                                                             | 必須パラメータ | 任意パラメータ                                                          |
| ----------------- | ---------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------- |
| `get_audit_logs`  | 管理者操作の監査ログを取得する（ページネーション・フィルタ対応） | —              | `page?`, `limit?`, `action?`, `admin_user_id?`, `target_id?`, `status?` |
| `get_audit_stats` | 監査ログの統計情報を取得する（アクション別・管理者別・日別集計） | —              | `days?`                                                                 |

### メトリクス (7 tools)

| ツール名                  | 説明                                                                   | 必須パラメータ | 任意パラメータ             |
| ------------------------- | ---------------------------------------------------------------------- | -------------- | -------------------------- |
| `get_system_metrics`      | システムメトリクス（ユーザー数、サービス数、ログイン統計等）を取得する | —              | `days?`                    |
| `get_suspicious_logins`   | 短時間に複数国からログインした疑わしいアカウントを検出する             | —              | `hours?`, `min_countries?` |
| `get_service_token_stats` | 全サービスのアクティブトークン統計を取得する                           | —              | —                          |
| `get_active_user_stats`   | DAU/WAU/MAU を取得する                                                 | —              | —                          |
| `get_daily_active_users`  | 日別アクティブユーザー数の推移を取得する                               | —              | `days?`                    |
| `get_login_trends`        | 日別ログイン数の推移を取得する                                         | —              | `days?`                    |
| `get_user_registrations`  | 日別ユーザー登録数の推移を取得する                                     | —              | `days?`                    |

## ツールパラメータスキーマ

各ツールの `inputSchema`（JSON Schema 形式）の詳細定義。MCP クライアントは `tools/list` でこれらのスキーマを取得できる。

---

### ユーザー管理

#### `list_users`

ユーザー一覧を取得する（ページネーション・検索対応）。

| パラメータ | 型       | 必須 | 説明                                             |
| ---------- | -------- | ---- | ------------------------------------------------ |
| `page`     | `number` | —    | ページ番号（1始まり、デフォルト: 1）             |
| `limit`    | `number` | —    | 1ページあたりの件数（デフォルト: 50、最大: 100） |
| `search`   | `string` | —    | メールアドレスまたは名前で部分一致検索           |
| `role`     | `string` | —    | ロールでフィルタ。`"user"` または `"admin"`      |

**レスポンス例:**

```json
{
  "users": [
    {
      "id": "uuid",
      "email": "user@example.com",
      "name": "山田太郎",
      "role": "user",
      "banned_at": null,
      "created_at": "2026-01-01T00:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 123,
    "totalPages": 3
  }
}
```

#### `get_user`

指定ユーザーの詳細情報を取得する。

| パラメータ | 型       | 必須 | 説明       |
| ---------- | -------- | ---- | ---------- |
| `user_id`  | `string` | Yes  | ユーザーID |

#### `ban_user`

ユーザーを BAN する。BAN と同時に全トークン失効・MCP セッション削除がアトミックに実行される。

| パラメータ | 型       | 必須 | 説明                  |
| ---------- | -------- | ---- | --------------------- |
| `user_id`  | `string` | Yes  | BAN するユーザーの ID |

#### `unban_user`

ユーザーの BAN を解除する。

| パラメータ | 型       | 必須 | 説明                      |
| ---------- | -------- | ---- | ------------------------- |
| `user_id`  | `string` | Yes  | BAN 解除するユーザーの ID |

#### `delete_user`

ユーザーを削除する（この操作は取り消せません）。削除前に全トークン失効・MCP セッション削除が実行される。

| パラメータ | 型       | 必須 | 説明                  |
| ---------- | -------- | ---- | --------------------- |
| `user_id`  | `string` | Yes  | 削除するユーザーの ID |

#### `update_user_role`

ユーザーのロールを変更する（user <-> admin）。ロール変更と同時に全トークン失効・MCP セッション削除がアトミックに実行される。

| パラメータ | 型       | 必須 | 説明                                    |
| ---------- | -------- | ---- | --------------------------------------- |
| `user_id`  | `string` | Yes  | ロールを変更するユーザーの ID           |
| `role`     | `string` | Yes  | 新しいロール。`"user"` または `"admin"` |

#### `get_user_login_history`

ユーザーのログイン履歴を取得する。

| パラメータ | 型       | 必須 | 説明                                  |
| ---------- | -------- | ---- | ------------------------------------- |
| `user_id`  | `string` | Yes  | ユーザーID                            |
| `limit`    | `number` | —    | 取得件数（デフォルト: 20、最大: 100） |

#### `get_user_login_stats`

ユーザーのプロバイダー別ログイン統計を取得する。

| パラメータ | 型       | 必須 | 説明                                        |
| ---------- | -------- | ---- | ------------------------------------------- |
| `user_id`  | `string` | Yes  | ユーザーID                                  |
| `days`     | `number` | —    | 集計対象の日数（デフォルト: 30、最大: 365） |

#### `get_user_login_trends`

ユーザーの日別ログイントレンドを取得する。

| パラメータ | 型       | 必須 | 説明                                        |
| ---------- | -------- | ---- | ------------------------------------------- |
| `user_id`  | `string` | Yes  | ユーザーID                                  |
| `days`     | `number` | —    | 集計対象の日数（デフォルト: 30、最大: 365） |

#### `get_user_providers`

ユーザーの連携済みプロバイダー一覧を取得する。

| パラメータ | 型       | 必須 | 説明       |
| ---------- | -------- | ---- | ---------- |
| `user_id`  | `string` | Yes  | ユーザーID |

#### `list_user_sessions`

ユーザーのアクティブセッション一覧を取得する（IdP セッション・サービストークン両方を含む）。

| パラメータ | 型       | 必須 | 説明       |
| ---------- | -------- | ---- | ---------- |
| `user_id`  | `string` | Yes  | ユーザーID |

#### `revoke_user_sessions`

ユーザーの全アクティブセッションを失効させる（強制ログアウト）。全トークン失効・MCP セッション削除が実行される。

| パラメータ | 型       | 必須 | 説明                                |
| ---------- | -------- | ---- | ----------------------------------- |
| `user_id`  | `string` | Yes  | セッションを失効させるユーザーの ID |

#### `get_user_owned_services`

ユーザーが所有するサービス一覧を取得する（ユーザー削除前の所有権確認に使用）。

| パラメータ | 型       | 必須 | 説明       |
| ---------- | -------- | ---- | ---------- |
| `user_id`  | `string` | Yes  | ユーザーID |

#### `get_user_authorized_services`

ユーザーが認可済みのサービス（連携中のサービス）一覧を取得する。

| パラメータ | 型       | 必須 | 説明       |
| ---------- | -------- | ---- | ---------- |
| `user_id`  | `string` | Yes  | ユーザーID |

---

### サービス管理

#### `list_services`

サービス（OAuth クライアント）一覧を取得する（ページネーション・検索対応）。

| パラメータ | 型       | 必須 | 説明                                             |
| ---------- | -------- | ---- | ------------------------------------------------ |
| `page`     | `number` | —    | ページ番号（1始まり、デフォルト: 1）             |
| `limit`    | `number` | —    | 1ページあたりの件数（デフォルト: 20、最大: 100） |
| `name`     | `string` | —    | サービス名で部分一致検索                         |

**レスポンス例:**

```json
{
  "services": [
    {
      "id": "uuid",
      "name": "My App",
      "client_id": "cli_xxxx",
      "allowed_scopes": ["openid", "profile", "email"],
      "owner_user_id": "uuid",
      "created_at": "2026-01-01T00:00:00.000Z",
      "updated_at": "2026-01-01T00:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 5,
    "totalPages": 1
  }
}
```

#### `get_service`

サービス（OAuth クライアント）の詳細情報を取得する。`client_secret_hash` は返却されない。

| パラメータ   | 型       | 必須 | 説明       |
| ------------ | -------- | ---- | ---------- |
| `service_id` | `string` | Yes  | サービスID |

#### `create_service`

新規サービス（OAuth クライアント）を登録する。作成後に `client_id` と `client_secret` が返される（`client_secret` は再取得不可）。

| パラメータ       | 型         | 必須 | 説明                                                                   |
| ---------------- | ---------- | ---- | ---------------------------------------------------------------------- |
| `name`           | `string`   | Yes  | サービス名                                                             |
| `allowed_scopes` | `string[]` | —    | 許可するスコープの配列（デフォルト: `["openid", "profile", "email"]`） |

#### `update_service`

サービスの名前または許可スコープを更新する。`name` と `allowed_scopes` のいずれか一方は必須。

| パラメータ       | 型         | 必須 | 説明                                                           |
| ---------------- | ---------- | ---- | -------------------------------------------------------------- |
| `service_id`     | `string`   | Yes  | サービスID                                                     |
| `name`           | `string`   | —    | 新しいサービス名                                               |
| `allowed_scopes` | `string[]` | —    | 許可するスコープの配列（例: `["openid", "profile", "email"]`） |

#### `delete_service`

サービスを削除する（この操作は取り消せません）。削除前に全ユーザーのアクティブトークンが失効される。

| パラメータ   | 型       | 必須 | 説明                  |
| ------------ | -------- | ---- | --------------------- |
| `service_id` | `string` | Yes  | 削除するサービスの ID |

#### `rotate_service_secret`

サービスのクライアントシークレットをローテーションする。新しい `client_secret` が返される（再取得不可）。

| パラメータ   | 型       | 必須 | 説明                                          |
| ------------ | -------- | ---- | --------------------------------------------- |
| `service_id` | `string` | Yes  | シークレットをローテーションするサービスの ID |

#### `list_redirect_uris`

サービスに登録されているリダイレクト URI の一覧を取得する。

| パラメータ   | 型       | 必須 | 説明       |
| ------------ | -------- | ---- | ---------- |
| `service_id` | `string` | Yes  | サービスID |

#### `add_redirect_uri`

サービスにリダイレクト URI を追加する（https 必須、localhost のみ http 可、フラグメント禁止）。

| パラメータ   | 型       | 必須 | 説明                     |
| ------------ | -------- | ---- | ------------------------ |
| `service_id` | `string` | Yes  | サービスID               |
| `uri`        | `string` | Yes  | 追加するリダイレクト URI |

#### `delete_redirect_uri`

サービスからリダイレクト URI を削除する。

| パラメータ   | 型       | 必須 | 説明                           |
| ------------ | -------- | ---- | ------------------------------ |
| `service_id` | `string` | Yes  | サービスID                     |
| `uri_id`     | `string` | Yes  | 削除するリダイレクト URI の ID |

#### `list_service_users`

サービスを認可済みのユーザー一覧を取得する（ページネーション対応）。

| パラメータ   | 型       | 必須 | 説明                                             |
| ------------ | -------- | ---- | ------------------------------------------------ |
| `service_id` | `string` | Yes  | サービスID                                       |
| `page`       | `number` | —    | ページ番号（1始まり、デフォルト: 1）             |
| `limit`      | `number` | —    | 1ページあたりの件数（デフォルト: 50、最大: 100） |

#### `revoke_service_user_access`

指定ユーザーの特定サービスへのアクセスを失効させる（そのサービスのトークンのみ失効）。

| パラメータ   | 型       | 必須 | 説明                              |
| ------------ | -------- | ---- | --------------------------------- |
| `service_id` | `string` | Yes  | サービスID                        |
| `user_id`    | `string` | Yes  | アクセスを失効させるユーザーの ID |

#### `transfer_service_ownership`

サービスの所有権を別のユーザーに転送する。

| パラメータ          | 型       | 必須 | 説明                          |
| ------------------- | -------- | ---- | ----------------------------- |
| `service_id`        | `string` | Yes  | 所有権を転送するサービスの ID |
| `new_owner_user_id` | `string` | Yes  | 新しいオーナーのユーザーID    |

---

### 監査ログ

#### `get_audit_logs`

管理者操作の監査ログを取得する（ページネーション・フィルタ対応）。

| パラメータ      | 型       | 必須 | 説明                                                           |
| --------------- | -------- | ---- | -------------------------------------------------------------- |
| `page`          | `number` | —    | ページ番号（1始まり、デフォルト: 1）                           |
| `limit`         | `number` | —    | 1ページあたりの件数（デフォルト: 50、最大: 100）               |
| `action`        | `string` | —    | アクション名でフィルタ（例: `"user.ban"`, `"service.create"`） |
| `admin_user_id` | `string` | —    | 操作した管理者のユーザーIDでフィルタ                           |
| `target_id`     | `string` | —    | 操作対象のIDでフィルタ                                         |
| `status`        | `string` | —    | ステータスでフィルタ。`"success"` または `"failure"`           |

**レスポンス例:**

```json
{
  "logs": [
    {
      "id": "uuid",
      "admin_user_id": "uuid",
      "action": "user.ban",
      "target_type": "user",
      "target_id": "uuid",
      "status": "success",
      "details": {},
      "created_at": "2026-04-01T12:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 42,
    "totalPages": 1
  }
}
```

#### `get_audit_stats`

監査ログの統計情報を取得する（アクション別・管理者別・日別集計）。

| パラメータ | 型       | 必須 | 説明                                            |
| ---------- | -------- | ---- | ----------------------------------------------- |
| `days`     | `number` | —    | 日別集計の対象日数（デフォルト: 30、最大: 365） |

---

### メトリクス

#### `get_system_metrics`

システムメトリクス（ユーザー数、サービス数、ログイン統計、アクティブユーザー統計等）を取得する。

| パラメータ | 型       | 必須 | 説明                                                |
| ---------- | -------- | ---- | --------------------------------------------------- |
| `days`     | `number` | —    | トレンド統計の対象日数（デフォルト: 30、最大: 365） |

**レスポンス例:**

```json
{
  "summary": {
    "total_users": 1234,
    "total_services": 5,
    "dau": 89,
    "wau": 432,
    "mau": 987
  },
  "trends": {
    "days": 30,
    "daily_logins": [...],
    "daily_registrations": [...],
    "daily_active_users": [...],
    "login_by_provider": [...]
  }
}
```

#### `get_suspicious_logins`

短時間に複数の国からログインした疑わしいアカウントを検出する。

| パラメータ      | 型       | 必須 | 説明                                             |
| --------------- | -------- | ---- | ------------------------------------------------ |
| `hours`         | `number` | —    | 遡る時間数（1〜168、デフォルト: 24）             |
| `min_countries` | `number` | —    | 疑わしいとみなす最低国数（2〜10、デフォルト: 2） |

#### `get_service_token_stats`

全サービスのアクティブトークン統計（認可ユーザー数・トークン数）を取得する。

パラメータなし。

#### `get_active_user_stats`

DAU/WAU/MAU（日次・週次・月次アクティブユーザー数）を取得する。

パラメータなし。

#### `get_daily_active_users`

日別アクティブユーザー数の推移を取得する。

| パラメータ | 型       | 必須 | 説明                              |
| ---------- | -------- | ---- | --------------------------------- |
| `days`     | `number` | —    | 遡る日数（1〜90、デフォルト: 30） |

#### `get_login_trends`

日別ログイン数の推移を取得する。

| パラメータ | 型       | 必須 | 説明                               |
| ---------- | -------- | ---- | ---------------------------------- |
| `days`     | `number` | —    | 遡る日数（1〜365、デフォルト: 30） |

#### `get_user_registrations`

日別ユーザー登録数の推移を取得する。

| パラメータ | 型       | 必須 | 説明                               |
| ---------- | -------- | ---- | ---------------------------------- |
| `days`     | `number` | —    | 遡る日数（1〜365、デフォルト: 30） |

## エラーコード

### JSON-RPC エラー

| コード   | 意味                                           |
| -------- | ---------------------------------------------- |
| `-32700` | Parse error（リクエスト JSON が不正）          |
| `-32600` | Invalid Request（セッション無効）              |
| `-32601` | Method not found                               |
| `-32602` | Invalid params（ツール名不明、パラメータ不正） |

### HTTP エラー

| ステータス | 意味                                    | WWW-Authenticate                 |
| ---------- | --------------------------------------- | -------------------------------- |
| 401        | 未認証（トークン不正/期限切れ/BAN済み） | `Bearer resource_metadata="..."` |
| 403        | 権限不足（管理者ロール必須）            | —                                |
| 429        | レートリミット超過                      | —                                |
| 500        | サーバーエラー                          | —                                |

## ヘルスチェック

```
GET https://mcp.0g0.xyz/health
```

```json
{
  "status": "ok",
  "worker": "mcp",
  "timestamp": "2026-04-15T12:00:00.000Z"
}
```

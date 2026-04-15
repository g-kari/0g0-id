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

| ツール名                       | 説明                                                 | パラメータ                     |
| ------------------------------ | ---------------------------------------------------- | ------------------------------ |
| `list_users`                   | ユーザー一覧を取得する（ページネーション・検索対応） | `limit?`, `offset?`, `search?` |
| `get_user`                     | 指定ユーザーの詳細情報を取得する                     | `user_id`                      |
| `ban_user`                     | ユーザーを BAN する                                  | `user_id`                      |
| `unban_user`                   | ユーザーの BAN を解除する                            | `user_id`                      |
| `delete_user`                  | ユーザーを削除する（取り消し不可）                   | `user_id`                      |
| `update_user_role`             | ユーザーのロールを変更する（user ↔ admin）           | `user_id`, `role`              |
| `get_user_login_history`       | ユーザーのログイン履歴を取得する                     | `user_id`                      |
| `get_user_login_stats`         | ユーザーのプロバイダー別ログイン統計を取得する       | `user_id`                      |
| `get_user_login_trends`        | ユーザーの日別ログイントレンドを取得する             | `user_id`                      |
| `get_user_providers`           | ユーザーの連携済みプロバイダー一覧を取得する         | `user_id`                      |
| `list_user_sessions`           | ユーザーのアクティブセッション一覧を取得する         | `user_id`                      |
| `revoke_user_sessions`         | ユーザーの全セッションを失効させる（強制ログアウト） | `user_id`                      |
| `get_user_owned_services`      | ユーザーが所有するサービス一覧を取得する             | `user_id`                      |
| `get_user_authorized_services` | ユーザーが認可済みのサービス一覧を取得する           | `user_id`                      |

### サービス管理 (12 tools)

| ツール名                     | 説明                                                              | パラメータ                               |
| ---------------------------- | ----------------------------------------------------------------- | ---------------------------------------- |
| `list_services`              | サービス一覧を取得する（ページネーション・検索対応）              | `limit?`, `offset?`, `search?`           |
| `get_service`                | サービスの詳細情報を取得する                                      | `service_id`                             |
| `create_service`             | 新規サービスを登録する（client_secret は作成時のみ返却）          | `name`, `allowed_scopes?`                |
| `update_service`             | サービスの名前または許可スコープを更新する                        | `service_id`, `name?`, `allowed_scopes?` |
| `delete_service`             | サービスを削除する（取り消し不可）                                | `service_id`                             |
| `rotate_service_secret`      | クライアントシークレットをローテーションする（再取得不可）        | `service_id`                             |
| `list_redirect_uris`         | リダイレクト URI 一覧を取得する                                   | `service_id`                             |
| `add_redirect_uri`           | リダイレクト URI を追加する（HTTPS 必須、localhost のみ HTTP 可） | `service_id`, `uri`                      |
| `delete_redirect_uri`        | リダイレクト URI を削除する                                       | `service_id`, `uri_id`                   |
| `list_service_users`         | サービスを認可済みのユーザー一覧を取得する                        | `service_id`, `limit?`, `offset?`        |
| `revoke_service_user_access` | ユーザーのサービスアクセスを失効させる                            | `service_id`, `user_id`                  |
| `transfer_service_ownership` | サービスの所有権を別ユーザーに転送する                            | `service_id`, `new_owner_user_id`        |

### 監査ログ (2 tools)

| ツール名          | 説明                                                             | パラメータ                                       |
| ----------------- | ---------------------------------------------------------------- | ------------------------------------------------ |
| `get_audit_logs`  | 管理者操作の監査ログを取得する（ページネーション・フィルタ対応） | `limit?`, `offset?`, `action?`, `admin_user_id?` |
| `get_audit_stats` | 監査ログの統計情報を取得する（アクション別・管理者別・日別集計） | `days?`                                          |

### メトリクス (7 tools)

| ツール名                  | 説明                                                                   | パラメータ             |
| ------------------------- | ---------------------------------------------------------------------- | ---------------------- |
| `get_system_metrics`      | システムメトリクス（ユーザー数、サービス数、ログイン統計等）を取得する | _(なし)_               |
| `get_suspicious_logins`   | 短時間に複数国からログインした疑わしいアカウントを検出する             | `hours?`, `threshold?` |
| `get_service_token_stats` | 全サービスのアクティブトークン統計を取得する                           | _(なし)_               |
| `get_active_user_stats`   | DAU/WAU/MAU を取得する                                                 | _(なし)_               |
| `get_daily_active_users`  | 日別アクティブユーザー数の推移を取得する                               | `days?`                |
| `get_login_trends`        | 日別ログイン数の推移を取得する                                         | `days?`                |
| `get_user_registrations`  | 日別ユーザー登録数の推移を取得する                                     | `days?`                |

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

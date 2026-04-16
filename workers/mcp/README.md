# 0g0-id MCP Server

0g0-id の統合ID基盤（IdP）を操作するための [Model Context Protocol (MCP)](https://modelcontextprotocol.io) サーバー。

Claude Code や MCP 対応クライアントから、ユーザー管理・サービス管理・監査ログ・メトリクスを操作できる。

## エンドポイント

| URL                                                        | 説明                                         |
| ---------------------------------------------------------- | -------------------------------------------- |
| `https://mcp.0g0.xyz/mcp`                                  | MCP JSON-RPC エンドポイント                  |
| `https://mcp.0g0.xyz/health`                               | ヘルスチェック                               |
| `https://mcp.0g0.xyz/.well-known/oauth-protected-resource` | OAuth Protected Resource Metadata (RFC 9728) |

## 認証

**Bearer Token 認証**（管理者ロール必須）

IdP (`id.0g0.xyz`) で発行された ES256 JWT アクセストークンを `Authorization` ヘッダーに設定する。

```
Authorization: Bearer <access_token>
```

### 要件

- トークンは `id.0g0.xyz` が発行した有効な JWT
- `role: "admin"` であること
- BAN されていないこと
- `jti` クレームが含まれていること（リボークチェック用）

認証失敗時は `WWW-Authenticate` ヘッダーで Protected Resource Metadata の URL を返す。

## プロトコル

MCP 2025-03-26 仕様に準拠した JSON-RPC 2.0 over HTTP。

### セッションライフサイクル

1. **初期化**: `POST /mcp` で `initialize` メソッドを呼び出す → `Mcp-Session-Id` がレスポンスヘッダーで返される
2. **ツール呼び出し**: 以降のリクエストに `Mcp-Session-Id` ヘッダーを付与
3. **切断**: `DELETE /mcp` で `Mcp-Session-Id` を渡してセッション終了

### リクエスト例

```bash
# 1. 初期化
curl -X POST https://mcp.0g0.xyz/mcp \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"my-client","version":"1.0"}}}'

# 2. ツール一覧取得
curl -X POST https://mcp.0g0.xyz/mcp \
  -H "Authorization: Bearer <token>" \
  -H "Mcp-Session-Id: <session_id>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 3. ツール呼び出し
curl -X POST https://mcp.0g0.xyz/mcp \
  -H "Authorization: Bearer <token>" \
  -H "Mcp-Session-Id: <session_id>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_users","arguments":{"page":1,"limit":10}}}'
```

## ツール一覧

### ユーザー管理

| ツール名                       | 説明                                       | 必須パラメータ    |
| ------------------------------ | ------------------------------------------ | ----------------- |
| `list_users`                   | ユーザー一覧（ページネーション・検索対応） | —                 |
| `get_user`                     | ユーザー詳細情報                           | `user_id`         |
| `ban_user`                     | ユーザーBAN                                | `user_id`         |
| `unban_user`                   | BAN解除                                    | `user_id`         |
| `delete_user`                  | ユーザー削除（不可逆）                     | `user_id`         |
| `update_user_role`             | ロール変更（user ↔ admin）                 | `user_id`, `role` |
| `get_user_login_history`       | ログイン履歴                               | `user_id`         |
| `get_user_login_stats`         | プロバイダー別ログイン統計                 | `user_id`         |
| `get_user_login_trends`        | 日別ログイントレンド                       | `user_id`         |
| `get_user_providers`           | 連携済みプロバイダー一覧                   | `user_id`         |
| `list_user_sessions`           | アクティブセッション一覧                   | `user_id`         |
| `revoke_user_sessions`         | 全セッション失効（強制ログアウト）         | `user_id`         |
| `get_user_owned_services`      | 所有サービス一覧                           | `user_id`         |
| `get_user_authorized_services` | 認可済みサービス一覧                       | `user_id`         |

### サービス管理（OAuth クライアント）

| ツール名                     | 説明                                       | 必須パラメータ                    |
| ---------------------------- | ------------------------------------------ | --------------------------------- |
| `list_services`              | サービス一覧（ページネーション・検索対応） | —                                 |
| `get_service`                | サービス詳細情報                           | `service_id`                      |
| `create_service`             | 新規サービス登録                           | `name`                            |
| `update_service`             | サービス名・スコープ更新                   | `service_id`                      |
| `delete_service`             | サービス削除（不可逆）                     | `service_id`                      |
| `rotate_service_secret`      | クライアントシークレットローテーション     | `service_id`                      |
| `list_redirect_uris`         | リダイレクトURI一覧                        | `service_id`                      |
| `add_redirect_uri`           | リダイレクトURI追加                        | `service_id`, `uri`               |
| `delete_redirect_uri`        | リダイレクトURI削除                        | `service_id`, `uri_id`            |
| `list_service_users`         | サービス認可済みユーザー一覧               | `service_id`                      |
| `revoke_service_user_access` | ユーザーのサービスアクセス失効             | `service_id`, `user_id`           |
| `transfer_service_ownership` | サービス所有権転送                         | `service_id`, `new_owner_user_id` |

### 監査ログ

| ツール名          | 説明                                         | 必須パラメータ |
| ----------------- | -------------------------------------------- | -------------- |
| `get_audit_logs`  | 管理者操作の監査ログ（フィルタ対応）         | —              |
| `get_audit_stats` | 監査ログ統計（アクション別・管理者別・日別） | —              |

### メトリクス

| ツール名                  | 説明                                             | 必須パラメータ |
| ------------------------- | ------------------------------------------------ | -------------- |
| `get_system_metrics`      | システムメトリクス（ユーザー数、ログイン統計等） | —              |
| `get_suspicious_logins`   | 複数国からの疑わしいログイン検出                 | —              |
| `get_service_token_stats` | サービス別アクティブトークン統計                 | —              |
| `get_active_user_stats`   | DAU/WAU/MAU                                      | —              |
| `get_daily_active_users`  | 日別アクティブユーザー推移                       | —              |
| `get_login_trends`        | 日別ログイン数推移                               | —              |
| `get_user_registrations`  | 日別ユーザー登録数推移                           | —              |

## レートリミット

MCP エンドポイントにはレートリミットが設定されている。制限超過時は `429 Too Many Requests` を返す。

## Claude Code での利用

`~/.claude/settings.json` または `.claude/settings.json` に以下を追加:

```json
{
  "mcpServers": {
    "0g0-id": {
      "type": "url",
      "url": "https://mcp.0g0.xyz/mcp",
      "headers": {
        "Authorization": "Bearer <access_token>"
      }
    }
  }
}
```

# id Worker API 仕様書

**ベースURL**: `https://id.0g0.xyz`
**役割**: IdP コア API（認証・JWT 発行・ユーザー／サービス管理・トークン）
**ソース仕様**:
`workers/id/src/routes/openapi/internal-spec.ts`（内部） / `external-spec.ts`（外部）
**インタラクティブ版**:
[`/docs`](https://id.0g0.xyz/docs)（内部） / [`/docs/external`](https://id.0g0.xyz/docs/external)（外部）

本ドキュメントは上記 OpenAPI 3.1 仕様の要約である。リクエスト／レスポンススキーマの一次情報は必ず上記ソースファイルを参照すること。

## 認証方式

| 方式             | ヘッダー                                                 | 用途                                                                                                                    |
| ---------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `BearerAuth`     | `Authorization: Bearer <JWT>`                            | アクセストークン（ES256 JWT、有効期限 15 分）                                                                           |
| `BasicAuth`      | `Authorization: Basic <Base64(client_id:client_secret)>` | サービス間 API（External・トークン系）。DB `services` テーブルで照合                                                    |
| `InternalSecret` | `X-Internal-Secret: <secret>`                            | BFF ↔ id Worker 内部呼び出し。BFF 毎の個別シークレット（`INTERNAL_SERVICE_SECRET_USER` / `_ADMIN`）で認証（issue #156） |

> 注: 表中で「InternalSecret」または「BasicAuth」の一方のみを示すエンドポイントでも、`serviceBindingMiddleware` で保護されるパス（`/auth/exchange`・`/auth/refresh`・`/auth/logout`・`/auth/dbsc/*`）は実際には **`X-Internal-Secret` OR `Authorization: Basic`** のいずれかで通過する。`InternalSecret` は BFF 内部通信の一次手段、`BasicAuth` は外部 OAuth クライアント用のフォールバック。

> 運用メモ（observability・issue #156）: `serviceBindingMiddleware` は認証結果を構造化ログ（ctx=`service-binding`）で出力する:
>
> - 成功: `internal secret authenticated`（`kind` = `user` / `admin`）・`service client authenticated`（`serviceId`）
> - 拒否: `internal secret mismatch`（ヘッダーあり＆不一致）・`service binding access denied`（最終 403）・`service client authentication error`（DB 例外）。不正アクセス試行の観測に使える。

## デプロイ運用

### BFF シークレットのプリフライト（issue #156）

`npm run deploy:id` は `wrangler deploy` の前段に `scripts/preflight-deploy.ts` を走らせ、`INTERNAL_SERVICE_SECRET_USER` / `INTERNAL_SERVICE_SECRET_ADMIN` の登録有無を確認する。片方でも未登録だと該当 BFF の全 `/auth/*` 呼び出しが 403 で落ちる。

| シナリオ                    | 必要な env                              | 挙動                                                 |
| --------------------------- | --------------------------------------- | ---------------------------------------------------- |
| ローカル手動                | なし                                    | 登録済み→INFO、未登録→warn のみで続行（fail-open）   |
| CI 本番                     | `PREFLIGHT_STRICT: "1"`（クォート必須） | 未登録なら exit 1 で `wrangler deploy` 手前で abort  |
| 緊急回避                    | `SKIP_PREFLIGHT=1`                      | wrangler CLI を呼ばずに即 exit 0                     |
| wrangler 未認証・オフライン | なし                                    | fail-open（wrangler 本体の失敗で別途検出される前提） |

共通コアは `packages/shared/src/lib/preflight-core.ts` にある��DBSC の `workers/{user,admin}/scripts/preflight-deploy.ts`（issue #155 Phase 3）と同パターン・同じ `PreflightRunner` インターフェースを使用。

- JWT 署名鍵: ES256（P-256 EC）／`jose` + WebCrypto
- アクセストークン: 15 分、リフレッシュトークン: 30 日（ローテーション＋再使用検出）

## 1. 標準 OAuth 2.0 / OIDC（外部向け・外部サービス公開）

| Method | Path                                      | 認証       | 説明                                                                                                      |
| ------ | ----------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| GET    | `/auth/authorize`                         | —          | RFC 6749 / OIDC Core 1.0 準拠の認可エンドポイント。PKCE (S256) 必須。                                     |
| POST   | `/api/token`                              | BasicAuth  | `authorization_code` / `refresh_token` / `device_code` の grant_type を受ける標準トークンエンドポイント。 |
| GET    | `/.well-known/openid-configuration`       | —          | OIDC Discovery メタデータ（24h キャッシュ可）。                                                           |
| GET    | `/.well-known/oauth-authorization-server` | —          | RFC 8414 メタデータ（MCP クライアント向け）。                                                             |
| GET    | `/.well-known/jwks.json`                  | —          | JWT 署名検証用の JWK Set（ES256 公開鍵、1h キャッシュ可）。                                               |
| GET    | `/api/userinfo`                           | BearerAuth | OIDC UserInfo（スコープに応じたクレーム）。                                                               |
| POST   | `/api/token/introspect`                   | BasicAuth  | RFC 7662 トークンイントロスペクション。                                                                   |
| POST   | `/api/token/revoke`                       | BasicAuth  | RFC 7009 トークン失効。                                                                                   |
| POST   | `/api/device/code`                        | BasicAuth  | OAuth Device Authorization Grant（RFC 8628）開始。                                                        |
| POST   | `/api/device/token`                       | BasicAuth  | Device grant でのトークン取得。                                                                           |

## 2. 独自認証フロー（BFF / 外部サービス両対応）

| Method | Path                   | 認証           | 説明                                                                                                                                                                                                                                                 |
| ------ | ---------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/auth/login`          | —              | ログイン開始。`redirect_to` / `state` 必須、`client_id` 指定で外部サービスフロー、PKCE 任意。                                                                                                                                                        |
| GET    | `/auth/callback`       | —              | 各 SNS プロバイダーからのコールバック。ワンタイム認可コード発行。                                                                                                                                                                                    |
| POST   | `/auth/exchange`       | BasicAuth      | ワンタイムコード → アクセストークン + リフレッシュトークン。PKCE 使用時は `code_verifier` 必須。                                                                                                                                                     |
| POST   | `/auth/refresh`        | BasicAuth      | リフレッシュトークンローテーション。再使用検出でファミリー全体失効。                                                                                                                                                                                 |
| POST   | `/auth/logout`         | BasicAuth      | リフレッシュトークンファミリー失効。                                                                                                                                                                                                                 |
| POST   | `/auth/link-intent`    | BearerAuth     | ログイン済みユーザーのプロバイダー連携用ワンタイム `link_token` 発行。                                                                                                                                                                               |
| POST   | `/auth/dbsc/bind`      | InternalSecret | DBSC 端末公開鍵を `bff_sessions` にバインド（BFF 専用 internal API）。`X-BFF-Origin` ヘッダ必須で `session.bff_origin` と一致確認。                                                                                                                  |
| POST   | `/auth/dbsc/challenge` | InternalSecret | DBSC リフレッシュ用 nonce 発行（BFF 専用 internal API）。端末バインド済みセッションのみ対象。TTL 60 秒。`X-BFF-Origin` 必須。                                                                                                                        |
| POST   | `/auth/dbsc/verify`    | InternalSecret | DBSC proof JWT 検証（BFF 専用 internal API）。登録公開鍵で ES256 署名検証・`aud` 一致・nonce ワンタイム消費（`jti`）。`X-BFF-Origin` 必須。                                                                                                          |
| POST   | `/auth/dbsc/status`    | InternalSecret | BFF セッションの端末バインド状態取得（BFF 専用 internal API）。`{ device_bound, device_bound_at }` を返す。`X-BFF-Origin` 必須。Phase 3 の機密操作必須化ミドルウェアが利用。存在しない／失効セッションは列挙攻撃対策で `device_bound=false` で応答。 |

## 3. ユーザー API（`/api/users/*`）

### 自分自身（Bearer 必須）

| Method | Path                                    | 用途                                                                                                                                               |
| ------ | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/users/me`                         | プロフィール取得                                                                                                                                   |
| PATCH  | `/api/users/me`                         | プロフィール更新（CSRF: Origin/Referer 検証）                                                                                                      |
| DELETE | `/api/users/me`                         | 退会（全トークン失効＋ユーザー削除）                                                                                                               |
| GET    | `/api/users/me/login-history`           | 自分のログイン履歴（`limit` / `offset` / `provider`）                                                                                              |
| GET    | `/api/users/me/login-stats`             | 自分のログイン統計（`days`）                                                                                                                       |
| GET    | `/api/users/me/login-trends`            | 自分のログイントレンド（`days`）                                                                                                                   |
| GET    | `/api/users/me/security-summary`        | 自分のセキュリティサマリ                                                                                                                           |
| GET    | `/api/users/me/data-export`             | 自分のデータエクスポート                                                                                                                           |
| GET    | `/api/users/me/connections`             | 連携サービス一覧                                                                                                                                   |
| DELETE | `/api/users/me/connections/:serviceId`  | サービス連携解除（CSRF 検証）                                                                                                                      |
| GET    | `/api/users/me/providers`               | 連携 SNS プロバイダー一覧                                                                                                                          |
| DELETE | `/api/users/me/providers/:provider`     | SNS プロバイダー連携解除（最後の 1 件は 409）                                                                                                      |
| GET    | `/api/users/me/tokens`                  | 自分のアクティブリフレッシュトークン一覧                                                                                                           |
| DELETE | `/api/users/me/tokens`                  | 全トークン失効                                                                                                                                     |
| DELETE | `/api/users/me/tokens/:tokenId`         | 個別トークン失効                                                                                                                                   |
| GET    | `/api/users/me/bff-sessions`            | 自分の BFF セッション一覧（`has_device_key` / `device_bound_at` 含む。公開鍵 JWK は返さない）                                                      |
| DELETE | `/api/users/me/bff-sessions/:sessionId` | 自分の特定 BFF セッションを失効（self-service・`bff_sessions.revoked_reason` は `user_self_revoke`・他ユーザー所属の sessionId は 404 に畳み込み） |

### 管理者 API（Bearer + admin ロール必須）

| Method | Path                                     | 用途                                                                                                                                                    |
| ------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/users`                             | ユーザー一覧（`limit` / `offset` / `email` / `name` / `role` フィルタ）                                                                                 |
| GET    | `/api/users/:id`                         | ユーザー詳細                                                                                                                                            |
| DELETE | `/api/users/:id`                         | ユーザー削除                                                                                                                                            |
| PATCH  | `/api/users/:id/role`                    | ロール変更（自身不可、既存トークン即時失効）                                                                                                            |
| PATCH  | `/api/users/:id/ban`                     | ユーザー BAN                                                                                                                                            |
| DELETE | `/api/users/:id/ban`                     | BAN 解除                                                                                                                                                |
| GET    | `/api/users/:id/services`                | 認可済みサービス一覧                                                                                                                                    |
| GET    | `/api/users/:id/owned-services`          | 所有サービス一覧                                                                                                                                        |
| GET    | `/api/users/:id/providers`               | 連携プロバイダー一覧                                                                                                                                    |
| GET    | `/api/users/:id/login-history`           | ログイン履歴                                                                                                                                            |
| GET    | `/api/users/:id/login-stats`             | ログイン統計                                                                                                                                            |
| GET    | `/api/users/:id/login-trends`            | ログイントレンド                                                                                                                                        |
| GET    | `/api/users/:id/tokens`                  | リフレッシュトークン一覧                                                                                                                                |
| DELETE | `/api/users/:id/tokens`                  | 全トークン失効                                                                                                                                          |
| DELETE | `/api/users/:id/tokens/:tokenId`         | 個別トークン失効                                                                                                                                        |
| GET    | `/api/users/:id/bff-sessions`            | BFF セッション一覧（`has_device_key` / `device_bound_at` 含む）                                                                                         |
| DELETE | `/api/users/:id/bff-sessions/:sessionId` | 単一 BFF セッション失効（管理者・`admin_audit_logs` に `user.bff_session_revoked` 記録・`bff_sessions.revoked_reason` は `admin_action:<adminUserId>`） |

> **強制ログアウトの完全化**: `DELETE /api/users/:id/bff-sessions/:sessionId` は BFF Cookie 経路のみを停止する。攻撃者が並行して握っている `refresh_tokens`（30日有効）や連携サービスのトークンは残るため、ハイジャック疑い時は併せて `DELETE /api/users/:id/tokens` も実行すること。
>
> **self-service の BFF セッション失効**: `DELETE /api/users/me/bff-sessions/:sessionId` はユーザー自身がハイジャック疑い時に使うエンドポイント。admin_audit_logs には書かず（`/me/tokens/:tokenId` と同じ扱い）、`bff_sessions.revoked_reason` に `user_self_revoke` を記録して trail を残す。`refresh_tokens` 側は `DELETE /api/users/me/tokens/:tokenId` で別途失効が必要。

## 4. サービス API（`/api/services/*`・管理者）

| Method | Path                                     | 用途                                               |
| ------ | ---------------------------------------- | -------------------------------------------------- |
| GET    | `/api/services`                          | サービス一覧                                       |
| POST   | `/api/services`                          | サービス新規作成（client_id / client_secret 発行） |
| GET    | `/api/services/:id`                      | サービス詳細                                       |
| PATCH  | `/api/services/:id`                      | サービス更新（name / allowed_scopes 等）           |
| DELETE | `/api/services/:id`                      | サービス削除                                       |
| POST   | `/api/services/:id/rotate-secret`        | client_secret ローテーション                       |
| PATCH  | `/api/services/:id/owner`                | オーナー変更                                       |
| GET    | `/api/services/:id/redirect-uris`        | リダイレクト URI 一覧                              |
| POST   | `/api/services/:id/redirect-uris`        | リダイレクト URI 追加                              |
| DELETE | `/api/services/:id/redirect-uris/:uriId` | リダイレクト URI 削除                              |
| GET    | `/api/services/:id/users`                | サービス認可済みユーザー一覧                       |
| DELETE | `/api/services/:id/users/:userId`        | サービスからユーザーを強制解除（全トークン失効）   |

## 5. 外部連携サービス向け（`/api/external/*`・BasicAuth）

| Method | Path                      | 用途                                                      |
| ------ | ------------------------- | --------------------------------------------------------- |
| GET    | `/api/external/users`     | 自サービス認可済みユーザー一覧（ペアワイズ `sub`）        |
| GET    | `/api/external/users/:id` | 内部 ID によるユーザー取得（IDOR 防止のため未認可は 404） |

返却される `sub` はサービスごとに固有のペアワイズ識別子。スコープ（`profile` / `email` / `phone` / `address`）に応じたフィールドのみ返却。

## 6. 運用・監視

| Method | Path                    | 認証                | 用途               |
| ------ | ----------------------- | ------------------- | ------------------ |
| GET    | `/api/health`           | —                   | ヘルスチェック     |
| GET    | `/api/metrics`          | BearerAuth（admin） | システムメトリクス |
| GET    | `/api/admin/audit-logs` | BearerAuth（admin） | 監査ログ           |

## エラーレスポンス形式

```jsonc
{
  "error": {
    "code": "UNAUTHORIZED", // 機械可読コード
    "message": "Invalid credentials", // 人間可読メッセージ
  },
}
```

代表コード: `UNAUTHORIZED` / `FORBIDDEN` / `BAD_REQUEST` / `NOT_FOUND` / `CONFLICT` / `TOO_MANY_REQUESTS` / `TOKEN_ROTATED` / `INTERNAL_SERVER_ERROR`。

OAuth 2.0 標準エンドポイント（`/auth/authorize` / `/api/token` 等）のみ RFC 6749 形式の `{ error, error_description }` を返す。

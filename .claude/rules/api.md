---
paths:
  - "workers/**/*.ts"
  - "packages/shared/**/*.ts"
---

# API設計規約

## レスポンス形式

### 成功レスポンス

```json
{ "data": { ... } }
```

### エラーレスポンス

```json
{ "error": { "code": "ERROR_CODE", "message": "説明" } }
```

## HTTPステータスコード

- 200: 成功（GET, PATCH）
- 201: 作成成功（POST）
- 204: 削除成功（DELETE）
- 400: バリデーションエラー
- 401: 未認証
- 403: 権限不足
- 404: リソース未検出
- 409: 競合（重複登録など）
- 500: サーバーエラー

## OpenAPI ドキュメント更新ルール

**API を追加・編集・削除したら、必ず `workers/id/src/routes/docs.ts` の OpenAPI 仕様も同じコミットで更新すること。**

| 変更の種類                                                                                                                               | 更新対象                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| id worker の API 追加・変更                                                                                                              | `INTERNAL_OPENAPI.paths`                                                                  |
| 外部サービス向け API（`/api/external/`, `/api/userinfo`, `/auth/`, `/api/token/introspect`, `/api/token/revoke`, `/.well-known/`）の変更 | `EXTERNAL_OPENAPI.paths`                                                                  |
| 新しいスキーマ型の追加                                                                                                                   | `INTERNAL_OPENAPI.components.schemas` および/または `EXTERNAL_OPENAPI.components.schemas` |
| API の削除                                                                                                                               | 対応する `paths` エントリも削除                                                           |

### チェック観点

- エンドポイントのパス・メソッドが一致しているか
- リクエスト/レスポンスのスキーマが実装と一致しているか
- 認証方式（BearerAuth / BasicAuth / Public）が正しいか
- タグが適切に分類されているか

## id.0g0.xyz エンドポイント一覧

| パス        | メソッド | 認証   | 説明                     |
| ----------- | -------- | ------ | ------------------------ |
| /api/health | GET      | Public | ヘルスチェック           |
| /auth/login | GET      | Public | Google認可へリダイレクト |

### /auth/login クエリパラメータ

| パラメータ              | 必須/任意                | 説明                         |
| ----------------------- | ------------------------ | ---------------------------- |
| `redirect_to`           | 必須                     | 認証後のリダイレクト先 URI   |
| `state`                 | 推奨                     | CSRF 防止用の不透明な文字列  |
| `client_id`             | **外部サービスでは必須** | 登録済みサービスの client_id |
| `code_challenge`        | PKCE 使用時              | S256 コードチャレンジ        |
| `code_challenge_method` | PKCE 使用時              | `S256` 固定                  |

#### client_id の扱い

- **BFF オリジン**（`user.0g0.xyz`, `admin.0g0.xyz`, `EXTRA_BFF_ORIGINS`）: `client_id` は省略可
- **外部サービス**（非 BFF オリジン、例: `rss.0g0.xyz`）: `client_id` は**必須**

`client_id` なしで外部オリジンから呼び出した場合:

- `400 Bad Request` — `{ "error": { "code": "BAD_REQUEST", "message": "client_id is required for external services" } }`
- ユーザーとサービスの紐付けが記録されないため `/api/users/me/connections` に表示されない

外部サービスのログイン URL 形式:

```
https://id.0g0.xyz/auth/login?client_id=<CLIENT_ID>&redirect_to=<登録済みURI>&state=<STATE>
```

| /auth/callback | GET | Public | Googleコールバック |
| /auth/exchange | POST | Service Bindings | ワンタイムコード交換 |
| /auth/logout | POST | Service Bindings | ログアウト |
| /auth/refresh | POST | Service Bindings | トークンリフレッシュ |
| /.well-known/jwks.json | GET | Public | JWKS公開鍵 |
| /.well-known/openid-configuration | GET | Public | OIDC Discovery Document |
| /api/userinfo | GET | JWT | OIDC UserInfo エンドポイント |
| /auth/link-intent | POST | JWT | SNSプロバイダー連携用ワンタイムトークン発行 |
| /api/users/me | GET/PATCH | JWT | 自ユーザー情報 |
| /api/users | GET | JWT+Admin | ユーザー一覧 |
| /api/token/introspect | POST | Basic認証 | トークンイントロスペクション |
| /api/token/revoke | POST | Basic認証 | トークン失効（RFC 7009） |
| /api/services | GET/POST | JWT+Admin | サービス管理 |
| /api/services/:id | DELETE | JWT+Admin | サービス削除 |
| /api/services/:id/redirect-uris | GET/POST/DELETE | JWT+Admin | redirect_uri管理 |
| /api/users/me/tokens | GET | JWT | アクティブセッション一覧 |
| /api/users/me/tokens | DELETE | JWT+CSRF | 全セッション無効化 |
| /api/users/me/providers | GET | JWT | SNSプロバイダー一覧 |
| /api/users/me/providers/:provider | DELETE | JWT+CSRF | SNSプロバイダー連携解除 |
| /api/users/me/connections | GET | JWT | 連携サービス一覧 |
| /api/users/me/connections/:serviceId | DELETE | JWT+CSRF | サービス連携解除 |
| /api/users/me/login-history | GET | JWT | ログイン履歴 |
| /api/users/:id | GET/DELETE | JWT+Admin | ユーザー詳細・削除 |
| /api/users/:id/role | PATCH | JWT+Admin+CSRF | ロール変更 |
| /api/users/:id/login-history | GET | JWT+Admin | ユーザーログイン履歴 |
| /api/users/:id/providers | GET | JWT+Admin | ユーザーSNS連携状態 |
| /api/users/:id/services | GET | JWT+Admin | ユーザー認可済みサービス |
| /api/users/:id/owned-services | GET | JWT+Admin | ユーザー所有サービス |
| /api/users/:id/tokens | DELETE | JWT+Admin+CSRF | ユーザー全セッション無効化 |
| /api/services/:id/rotate-secret | POST | JWT+Admin+CSRF | クライアントシークレット再発行 |
| /api/services/:id/owner | PATCH | JWT+Admin+CSRF | サービス所有権移譲 |
| /api/services/:id/users | GET | JWT+Admin | サービス認可済みユーザー |
| /api/services/:id/users/:userId | DELETE | JWT+Admin+CSRF | ユーザーのサービスアクセス失効 |
| /api/external/users | GET | Basic認証 | 外部: 認可済みユーザー一覧 |
| /api/external/users/:id | GET | Basic認証 | 外部: ユーザー取得 |
| /api/metrics | GET | JWT+Admin | メトリクス |
| /docs | GET | Public | IdP内部APIドキュメント |
| /docs/external | GET | Public | 外部連携サービス向けAPIドキュメント |

# admin Worker BFF API 仕様書

**ベースURL**: `https://admin.0g0.xyz`
**役割**: 管理者向け BFF（サービス管理 / ユーザー管理 / メトリクス / 監査ログ） + Astro SPA 配信
**ソース**: `workers/admin/src/index.ts` および `workers/admin/src/routes/*.ts`

## 認証・セキュリティ

- **セッション Cookie**: `__Host-admin-session`（HS256 署名、`access_token` / `refresh_token` / `user` を含む）
- **OAuth state Cookie**: `__Host-admin-oauth-state`
- **ロール検証**: `/api/*` すべてに管理者ロールミドルウェアを適用。`role !== "admin"` ならセッション Cookie を削除して 403。多層防御（IdP 側での降格も早期拒否）。
- **CSRF**: `/api/*` / `/auth/logout` に `bffCsrfMiddleware`。`/auth/dbsc/*` は Chrome 内部発のフローで Origin ヘッダが付かないため除外し、Cookie セッション + 自署 JWT (audience=SELF_ORIGIN) + bff_origin 一致確認の多層で防御。
- **DBSC（Phase 1-2）**: ログイン callback 応答に `Secure-Session-Registration: (ES256);path="/auth/dbsc/start"` を付与。Chrome は端末公開鍵で自署した登録 JWT を `/auth/dbsc/start` に送り、bff_sessions に紐付ける。Phase 2 は `/auth/dbsc/refresh` で challenge-response を実装（初回 403 + `Secure-Session-Challenge: "<nonce>"`、再送は `Sec-Session-Response` に proof JWT）。短寿命 Cookie 切替は Phase 3 で対応予定。
- **DBSC 機密操作必須化（Phase 3 導入 — issue #155）**: `/api/services/*` と `/api/users/*` の破壊的メソッド（POST/PATCH/PUT/DELETE）に `requireDbscBoundSession` ミドルウェアを適用。デフォルトは warn-only（未バインドでも通過・ログのみ）で、環境変数 `DBSC_ENFORCE_SENSITIVE="true"` を設定した環境では `403 DBSC_BINDING_REQUIRED` + `Secure-Session-Registration` ヘッダで拒否する。IdP 応答異常時は fail-open（管理操作の全停止を回避）。
- **デプロイ時 secret 存在チェック（Phase 3 — issue #155）**: `npm run deploy:admin` は `wrangler deploy` の前に `scripts/preflight-deploy.ts` を実行し、`DBSC_ENFORCE_SENSITIVE` が wrangler secret として登録済みか確認する。未登録なら warn-only モードでデプロイされる旨を警告出力するだけで続行する（`PREFLIGHT_STRICT=1` で abort、`SKIP_PREFLIGHT=1` でチェック省略）。wrangler CLI 未認証やオフライン時は fail-open で通過（deploy 本体で別途検出されるため、プリフライトでは block しない）。
- **CORS**: `/api/*` は自身のオリジンのみ許可
- **UUID 検証**: `:id` / `:userId` / `:tokenId` / `:uriId` などすべてのパスパラメータを UUID 形式で検証（不正なら 400）

## デプロイ運用

### プリフライトモード選択

`scripts/preflight-deploy.ts` は `npm run deploy:admin` 実行時に wrangler secret list を叩き、`DBSC_ENFORCE_SENSITIVE` secret の登録有無を確認する。挙動は以下の環境変数で切り替える:

| シナリオ                                          | 推奨設定                             | 挙動                                                                      |
| ------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------- |
| ローカル開発・手動デプロイ                        | なし（デフォルト）                   | secret 未登録でも warn のみで続行（fail-open）                            |
| **CI の本番デプロイ job**                         | **`PREFLIGHT_STRICT=1` を env 固定** | secret 未登録なら abort（exit 1）。登録漏れでの本番反映を事前遮断         |
| 緊急デプロイ（secret 未整備下で回避が必要な場合） | `SKIP_PREFLIGHT=1`                   | チェック自体を省略（`PREFLIGHT_STRICT` より優先）。通常運用では使用しない |

**注意**: `PREFLIGHT_STRICT` は厳密比較で `"1"` のみ strict 扱い。`"true"` / `"yes"` 等を設定しても警告が出るだけで strict モードにならない（`runPreflight` の誤設定検知ログが出る）。GitHub Actions の `env:` ブロックに書く際は明示的にクォートした `PREFLIGHT_STRICT: "1"` を指定すること。裸の `true` は YAML パーサが boolean 化するため `"1"` に一致せず、strict が有効にならない。admin は管理操作という影響範囲の広さから、CI 経路での deploy を採用するなら特に strict 固定を強く推奨する。

**混同注意 — プリフライト env と runtime env で受理値が逆**: preflight 側の `PREFLIGHT_STRICT` は `"1"` のみ受理する一方、runtime 側の `DBSC_ENFORCE_SENSITIVE`（`require-dbsc-bound.ts` の `isDbscEnforceValue`）は `"true"`（trim + case-insensitive）のみ enforce と判定する。両方を `"1"` で揃えると CI プリフライトは strict で通っても runtime は warn-only のままになるので、**secret 値は `"true"`、CI env は `"1"`** という組み合わせで設定すること。

現状このリポジトリには deploy workflow は存在せず、ローカル `npm run deploy:admin` で本番反映する運用となっている。将来 CI 経由の deploy job を追加する場合、該当 job の `env:` ブロックに `PREFLIGHT_STRICT: "1"` を固定設定することを推奨する（secret 登録漏れの本番反映を防ぐための運用ゲート — issue #155 Phase 3）。

## 認証フロー（`/auth/*`）

`createBffAuthRoutes()` 共通ルート。詳細は `packages/shared/src/routes/auth-routes.ts` を参照。

| Method | Path                 | 認証              | 説明                                                                                                                                                                                                                                     |
| ------ | -------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/auth/login`        | —                 | id Worker `/auth/login` へリダイレクト                                                                                                                                                                                                   |
| GET    | `/auth/callback`     | —                 | ワンタイムコード交換・セッション Cookie 発行。`Secure-Session-Registration` ヘッダで DBSC 登録を Chrome に開始させる                                                                                                                     |
| POST   | `/auth/logout`       | セッション Cookie | リフレッシュトークン失効・Cookie 削除                                                                                                                                                                                                    |
| POST   | `/auth/dbsc/start`   | セッション Cookie | DBSC 端末公開鍵バインド。Body は `application/jwt` または `{ "jwt": "..." }`。検証成功で `bff_sessions` に公開鍵保存。                                                                                                                   |
| POST   | `/auth/dbsc/refresh` | セッション Cookie | DBSC challenge-response リフレッシュ。初回 POST は `403` + `Secure-Session-Challenge: "<nonce>"`。Chrome は `Sec-Session-Response` ヘッダに端末秘密鍵で署名した proof JWT（`aud=SELF_ORIGIN` / `jti=<nonce>`）を付けて再送。成功時 200。 |

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

### `POST /auth/dbsc/refresh` の応答

**Phase 1（初回 POST, `Sec-Session-Response` 無し）**:

- Status: `403 Forbidden`
- Header: `Secure-Session-Challenge: "<nonce>"`（RFC 8941 Structured Field String）
- Body: `{ "error": { "code": "SESSION_CHALLENGE_REQUIRED", ... } }`

Chrome は発行された nonce を `jti` クレームに含めた proof JWT を端末秘密鍵（ES256）で署名し、`Sec-Session-Response` ヘッダに詰めて再送する。

**Phase 2（proof 提示, `Sec-Session-Response: <jwt>`）**:

- Status: `200 OK`（proof 検証成功・nonce ワンタイム消費）
- Body: `/auth/dbsc/start` と同形式（Phase 2 時点では既存 Cookie は据え置き）

エラー: 401 `UNAUTHORIZED`（Cookie なし）、400 `INVALID_REQUEST`（nonce 発行失敗・proof 形式不正）／ `INVALID_PROOF`（署名不一致・aud 不一致・nonce 期限切れ／消費済み、すべて列挙対策で一本化）、500 `INTERNAL_ERROR`（IdP 障害）。

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

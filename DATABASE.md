# データベーススキーマドキュメント

> 0g0-id（統合ID基盤）の Cloudflare D1 データベーススキーマ定義。  
> マイグレーション `0001` 〜 `0024` を適用した最終状態。

## テーブル一覧

| テーブル                                        | 役割                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| [users](#users)                                 | ユーザーアカウント（IdPのコアエンティティ）                        |
| [services](#services)                           | OAuth 2.0 クライアント（外部サービス登録）                         |
| [service_redirect_uris](#service_redirect_uris) | サービスごとの許可リダイレクトURI                                  |
| [auth_codes](#auth_codes)                       | 認可コード（BFFフロー + OAuth 2.0 Authorization Code）             |
| [refresh_tokens](#refresh_tokens)               | リフレッシュトークン（トークンファミリーによるローテーション管理） |
| [login_events](#login_events)                   | ログイン履歴（監査・セキュリティ用）                               |
| [admin_audit_logs](#admin_audit_logs)           | 管理者操作の監査ログ                                               |
| [device_codes](#device_codes)                   | Device Authorization Grant（RFC 8628）                             |
| [mcp_sessions](#mcp_sessions)                   | MCP（Model Context Protocol）セッション管理                        |
| [revoked_access_tokens](#revoked_access_tokens) | アクセストークン失効リスト（RFC 7009）                             |
| [bff_sessions](#bff_sessions)                   | BFF セッション（リモート失効・DBSC 端末バインド対応）              |
| [dbsc_challenges](#dbsc_challenges)             | DBSC リフレッシュ用 nonce の短寿命保存（challenge-response）       |

## テーブル間リレーション

```
users
 ├─< refresh_tokens     (user_id → users.id, CASCADE)
 ├─< auth_codes          (user_id → users.id, CASCADE)
 ├─< login_events        (user_id → users.id, CASCADE)
 ├─< device_codes        (user_id → users.id, CASCADE)
 ├─< bff_sessions        (user_id → users.id, CASCADE)
 │    └─< dbsc_challenges (session_id → bff_sessions.id, CASCADE)
 └─< services            (owner_user_id → users.id)

services
 ├─< service_redirect_uris  (service_id → services.id, CASCADE)
 ├─< refresh_tokens          (service_id → services.id, CASCADE)
 ├─< auth_codes              (service_id → services.id, CASCADE)
 └─< device_codes            (service_id → services.id, CASCADE)
```

---

## users

ユーザーアカウント。複数の外部プロバイダー（Google, LINE, Twitch, GitHub, X）でログイン可能。  
各プロバイダーの `sub`（Subject Identifier）をカラムとして保持する。

| カラム         | 型       | NULL | デフォルト      | 説明                                |
| -------------- | -------- | ---- | --------------- | ----------------------------------- |
| id             | TEXT     | NO   | —               | UUID（PK）                          |
| google_sub     | TEXT     | YES  | —               | Google の Subject Identifier        |
| line_sub       | TEXT     | YES  | —               | LINE の Subject Identifier          |
| twitch_sub     | TEXT     | YES  | —               | Twitch の Subject Identifier        |
| github_sub     | TEXT     | YES  | —               | GitHub の Subject Identifier        |
| x_sub          | TEXT     | YES  | —               | X（旧Twitter）の Subject Identifier |
| email          | TEXT     | NO   | —               | メールアドレス                      |
| email_verified | INTEGER  | NO   | 0               | メール検証済みフラグ（0/1）         |
| name           | TEXT     | NO   | —               | 表示名                              |
| picture        | TEXT     | YES  | —               | プロフィール画像URL                 |
| phone          | TEXT     | YES  | —               | 電話番号                            |
| address        | TEXT     | YES  | —               | 住所                                |
| role           | TEXT     | NO   | 'user'          | ロール（`user` / `admin`）          |
| banned_at      | DATETIME | YES  | —               | 停止日時（NULLなら有効）            |
| created_at     | TEXT     | NO   | datetime('now') | 作成日時                            |
| updated_at     | TEXT     | NO   | datetime('now') | 更新日時                            |

### インデックス

| 名前                 | カラム     | 種別          | 備考                           |
| -------------------- | ---------- | ------------- | ------------------------------ |
| idx_users_google_sub | google_sub | UNIQUE        | —                              |
| idx_users_line_sub   | line_sub   | UNIQUE        | —                              |
| idx_users_twitch_sub | twitch_sub | UNIQUE        | —                              |
| idx_users_github_sub | github_sub | UNIQUE (部分) | `WHERE github_sub IS NOT NULL` |
| idx_users_x_sub      | x_sub      | UNIQUE (部分) | `WHERE x_sub IS NOT NULL`      |
| idx_users_email      | email      | INDEX         | —                              |

### 設計メモ

- プロバイダーの `sub` は全て NULL 許容。ユーザーは少なくとも1つのプロバイダーでリンクされている前提
- `banned_at` が非NULLのユーザーはログイン・トークン発行を拒否される

---

## services

OAuth 2.0 クライアント。外部サービスがこのIdPを利用するために登録する。

| カラム             | 型   | NULL | デフォルト            | 説明                       |
| ------------------ | ---- | ---- | --------------------- | -------------------------- |
| id                 | TEXT | NO   | —                     | UUID（PK）                 |
| name               | TEXT | NO   | —                     | サービス名                 |
| client_id          | TEXT | NO   | —                     | OAuth 2.0 client_id        |
| client_secret_hash | TEXT | NO   | —                     | client_secret のハッシュ値 |
| allowed_scopes     | TEXT | NO   | '["profile","email"]' | 許可スコープ（JSON配列）   |
| owner_user_id      | TEXT | NO   | —                     | 登録した管理ユーザーのID   |
| created_at         | TEXT | NO   | datetime('now')       | 作成日時                   |
| updated_at         | TEXT | NO   | datetime('now')       | 更新日時                   |

### インデックス

| 名前                   | カラム    | 種別   |
| ---------------------- | --------- | ------ |
| idx_services_client_id | client_id | UNIQUE |

---

## service_redirect_uris

サービスごとの許可リダイレクトURI。認可リクエスト時に `redirect_uri` をホワイトリスト検証する。

| カラム     | 型   | NULL | デフォルト      | 説明                        |
| ---------- | ---- | ---- | --------------- | --------------------------- |
| id         | TEXT | NO   | —               | UUID（PK）                  |
| service_id | TEXT | NO   | —               | FK → services.id（CASCADE） |
| uri        | TEXT | NO   | —               | リダイレクトURI             |
| created_at | TEXT | NO   | datetime('now') | 作成日時                    |

### インデックス

| 名前                                 | カラム            | 種別   | 備考                      |
| ------------------------------------ | ----------------- | ------ | ------------------------- |
| idx_service_redirect_uris_service_id | service_id        | INDEX  | —                         |
| idx_service_redirect_uris_unique     | (service_id, uri) | UNIQUE | 同一サービスのURI重複防止 |

---

## auth_codes

認可コード。BFF内部フロー（`service_id = NULL`）と外部OAuth 2.0フロー（`service_id` あり）の両方に対応。

| カラム                | 型   | NULL | デフォルト      | 説明                                                            |
| --------------------- | ---- | ---- | --------------- | --------------------------------------------------------------- |
| id                    | TEXT | NO   | —               | UUID（PK）                                                      |
| user_id               | TEXT | NO   | —               | FK → users.id（CASCADE）                                        |
| code_hash             | TEXT | NO   | —               | 認可コードのハッシュ値                                          |
| redirect_to           | TEXT | NO   | —               | コールバックURL                                                 |
| expires_at            | TEXT | NO   | —               | 有効期限                                                        |
| used_at               | TEXT | YES  | —               | 使用日時（NULLなら未使用）                                      |
| created_at            | TEXT | NO   | datetime('now') | 作成日時                                                        |
| service_id            | TEXT | YES  | —               | FK → services.id（CASCADE）。NULLならBFFフロー                  |
| nonce                 | TEXT | YES  | —               | OIDC nonce（リプレイ攻撃防止）                                  |
| code_challenge        | TEXT | YES  | —               | PKCE code_challenge                                             |
| code_challenge_method | TEXT | YES  | —               | PKCE メソッド（`S256` 等）                                      |
| scope                 | TEXT | YES  | —               | 要求されたスコープ                                              |
| provider              | TEXT | YES  | —               | 認証に使用したプロバイダー（IDトークンの `amr` クレーム生成用） |

### インデックス

| 名前                     | カラム                  | 種別      | 備考                                              |
| ------------------------ | ----------------------- | --------- | ------------------------------------------------- |
| idx_auth_codes_code_hash | code_hash               | INDEX     | —                                                 |
| idx_auth_codes_active    | (code_hash, expires_at) | 部分INDEX | `WHERE used_at IS NULL`（未使用コードの高速検索） |

### 設計メモ

- `amr`（Authentication Methods References）: OIDC Core 1.0 準拠。`provider` カラムからIDトークン生成時に `amr` クレームを組み立てる
- PKCE: RFC 7636 準拠。`code_challenge` / `code_challenge_method` でコード横取り攻撃を防止

---

## refresh_tokens

リフレッシュトークン。`family_id` によるトークンファミリー管理で、トークンリプレイ検出を実現。

| カラム         | 型   | NULL | デフォルト      | 説明                                             |
| -------------- | ---- | ---- | --------------- | ------------------------------------------------ |
| id             | TEXT | NO   | —               | UUID（PK）                                       |
| user_id        | TEXT | NO   | —               | FK → users.id（CASCADE）                         |
| service_id     | TEXT | YES  | —               | FK → services.id（CASCADE）。NULLならBFFトークン |
| token_hash     | TEXT | NO   | —               | トークンのハッシュ値                             |
| family_id      | TEXT | NO   | —               | トークンファミリーID（ローテーション追跡）       |
| revoked_at     | TEXT | YES  | —               | 失効日時                                         |
| expires_at     | TEXT | NO   | —               | 有効期限（30日）                                 |
| created_at     | TEXT | NO   | datetime('now') | 作成日時                                         |
| revoked_reason | TEXT | YES  | —               | 失効理由（後述）                                 |
| pairwise_sub   | TEXT | YES  | —               | ペアワイズ Subject Identifier                    |
| scope          | TEXT | YES  | —               | 発行時のスコープ（スコープ昇格防止）             |

### revoked_reason の値

| 値                 | 意味                                       |
| ------------------ | ------------------------------------------ |
| user_logout        | ユーザーがログアウト                       |
| user_logout_all    | 全セッションログアウト                     |
| user_logout_others | 他セッションログアウト                     |
| reuse_detected     | トークンリプレイ検出（ファミリー全体失効） |
| service_delete     | サービス削除に伴う失効                     |
| service_revoke     | サービスによる明示的失効                   |
| rotation           | ローテーションによる旧トークン失効         |
| security_event     | セキュリティイベント                       |
| admin_action       | 管理者操作                                 |

### インデックス

| 名前                             | カラム                     | 種別      | 備考                                         |
| -------------------------------- | -------------------------- | --------- | -------------------------------------------- |
| idx_refresh_tokens_user_id       | user_id                    | INDEX     | —                                            |
| idx_refresh_tokens_token_hash    | token_hash                 | INDEX     | —                                            |
| idx_refresh_tokens_family_id     | family_id                  | INDEX     | —                                            |
| idx_refresh_tokens_active        | (token_hash, revoked_at)   | 部分INDEX | `WHERE revoked_at IS NULL`                   |
| idx_refresh_tokens_family_active | (family_id, revoked_at)    | 部分INDEX | `WHERE revoked_at IS NULL`（リプレイ検出用） |
| idx_refresh_tokens_pairwise_sub  | (service_id, pairwise_sub) | INDEX     | 外部APIの O(N) スキャン解消                  |

### 設計メモ

- **トークンファミリー**: 同一 `family_id` のトークンはローテーションチェーンを形成。失効済みトークンが再利用された場合、ファミリー全体を失効させる（リプレイ攻撃検出）
- **pairwise_sub**: OIDC Core 1.0 準拠。サービスごとに異なるユーザー識別子を返すことで、サービス間のユーザー追跡を防止
- **scope**: リフレッシュ時に発行時スコープを超えたトークン発行（スコープ昇格）を防止

---

## login_events

ログイン履歴。セキュリティ監査・不正アクセス検知に使用。

| カラム     | 型   | NULL | デフォルト      | 説明                                                |
| ---------- | ---- | ---- | --------------- | --------------------------------------------------- |
| id         | TEXT | NO   | —               | UUID（PK）                                          |
| user_id    | TEXT | NO   | —               | FK → users.id（CASCADE）                            |
| provider   | TEXT | NO   | —               | 認証プロバイダー（google, line, twitch, github, x） |
| ip_address | TEXT | YES  | —               | 接続元IPアドレス                                    |
| user_agent | TEXT | YES  | —               | User-Agent                                          |
| created_at | TEXT | NO   | datetime('now') | ログイン日時                                        |
| country    | TEXT | YES  | —               | 接続元国コード（CF-IPCountry ヘッダー）             |

### インデックス

| 名前                        | カラム     | 種別  |
| --------------------------- | ---------- | ----- |
| idx_login_events_user_id    | user_id    | INDEX |
| idx_login_events_created_at | created_at | INDEX |

---

## admin_audit_logs

管理者による操作の監査ログ。ロール変更・BAN・サービス削除などを記録。

| カラム        | 型       | NULL | デフォルト      | 説明                                             |
| ------------- | -------- | ---- | --------------- | ------------------------------------------------ |
| id            | TEXT     | NO   | —               | UUID（PK）                                       |
| admin_user_id | TEXT     | NO   | —               | 操作した管理者のユーザーID                       |
| action        | TEXT     | NO   | —               | 操作種別（例: role_change, ban, service_delete） |
| target_type   | TEXT     | NO   | —               | 対象の種別（例: user, service）                  |
| target_id     | TEXT     | NO   | —               | 対象のID                                         |
| details       | TEXT     | YES  | —               | 操作詳細（JSON）                                 |
| ip_address    | TEXT     | YES  | —               | 操作元IPアドレス                                 |
| status        | TEXT     | NO   | 'success'       | 操作結果（success / failure）                    |
| created_at    | DATETIME | NO   | datetime('now') | 操作日時                                         |

### インデックス

| 名前                               | カラム                   | 種別  | 備考                       |
| ---------------------------------- | ------------------------ | ----- | -------------------------- |
| idx_admin_audit_logs_admin_user_id | admin_user_id            | INDEX | —                          |
| idx_admin_audit_logs_created_at    | created_at DESC          | INDEX | 降順（最新操作の高速取得） |
| idx_admin_audit_logs_target        | (target_type, target_id) | INDEX | 対象単位の操作検索         |
| idx_admin_audit_logs_status        | status                   | INDEX | —                          |

### 設計メモ

- `admin_user_id` は FK 制約なし（管理者アカウント削除後も監査ログを保持するため）

---

## device_codes

Device Authorization Grant（RFC 8628）。TV・IoTデバイスなど入力制限のある環境でのOAuth認可に使用。

| カラム           | 型   | NULL | デフォルト      | 説明                                       |
| ---------------- | ---- | ---- | --------------- | ------------------------------------------ |
| id               | TEXT | NO   | —               | UUID（PK）                                 |
| device_code_hash | TEXT | NO   | —               | device_code のハッシュ値                   |
| user_code        | TEXT | NO   | —               | ユーザーに表示するコード                   |
| service_id       | TEXT | NO   | —               | FK → services.id（CASCADE）                |
| scope            | TEXT | YES  | —               | 要求スコープ                               |
| expires_at       | TEXT | NO   | —               | 有効期限                                   |
| user_id          | TEXT | YES  | —               | FK → users.id（CASCADE）。承認したユーザー |
| approved_at      | TEXT | YES  | —               | 承認日時                                   |
| denied_at        | TEXT | YES  | —               | 拒否日時                                   |
| last_polled_at   | TEXT | YES  | —               | デバイス側の最終ポーリング日時             |
| created_at       | TEXT | NO   | datetime('now') | 作成日時                                   |

### CHECK 制約

- `approved_at IS NULL OR user_id IS NOT NULL` — 承認時は必ずユーザーIDが必要

### インデックス

| 名前                       | カラム     | 種別  |
| -------------------------- | ---------- | ----- |
| idx_device_codes_user_code | user_code  | INDEX |
| idx_device_codes_expires   | expires_at | INDEX |

---

## mcp_sessions

MCP（Model Context Protocol）セッション管理。Worker のスケールアウトに対応するため D1 で永続化。

| カラム         | 型      | NULL | デフォルト | 説明                                   |
| -------------- | ------- | ---- | ---------- | -------------------------------------- |
| id             | TEXT    | NO   | —          | セッションID（PK）                     |
| created_at     | INTEGER | NO   | —          | 作成日時（Unix timestamp）             |
| last_active_at | INTEGER | NO   | —          | 最終アクティブ日時（Unix timestamp）   |
| user_id        | TEXT    | YES  | —          | 紐づくユーザーID（セッション無効化用） |

### インデックス

| 名前                            | カラム         | 種別  |
| ------------------------------- | -------------- | ----- |
| idx_mcp_sessions_last_active_at | last_active_at | INDEX |
| idx_mcp_sessions_user_id        | user_id        | INDEX |

### 設計メモ

- タイムスタンプは他テーブルと異なり **INTEGER（Unix epoch）** を使用（Workers ランタイムとの互換性）

---

## revoked_access_tokens

アクセストークン失効リスト（RFC 7009: Token Revocation）。JTI をキーとしたブロックリスト。

| カラム     | 型      | NULL | デフォルト  | 説明                                                                       |
| ---------- | ------- | ---- | ----------- | -------------------------------------------------------------------------- |
| jti        | TEXT    | NO   | —           | JWT ID（PK）                                                               |
| expires_at | INTEGER | NO   | —           | 元トークンの有効期限（Unix timestamp。期限切れレコードのクリーンアップ用） |
| revoked_at | INTEGER | NO   | unixepoch() | 失効日時（Unix timestamp）                                                 |

### インデックス

| 名前                                 | カラム     | 種別  | 備考                         |
| ------------------------------------ | ---------- | ----- | ---------------------------- |
| idx_revoked_access_tokens_expires_at | expires_at | INDEX | 期限切れレコードの定期削除用 |

### 設計メモ

- アクセストークン（JWT）は有効期限15分と短いが、明示的失効が必要なケース（ログアウト・セキュリティイベント）に対応
- `expires_at` を保持することで、元トークンの有効期限が過ぎたレコードを安全に削除できる（テーブル肥大化防止）

---

## bff_sessions

BFF（user.0g0.xyz / admin.0g0.xyz）のセッション Cookie を D1 上で任意失効可能にするテーブル。
Cookie 自体は AES-GCM で暗号化されているが、端末マルウェア等で漏洩した場合の強制失効手段として、
リクエスト毎に行の有効性を ID Worker 側で検証する。

DBSC（Device Bound Session Credentials）対応で `device_public_key_jwk` / `device_bound_at` 列を追加（migration 0024）。
Chrome 等が `POST /auth/dbsc/start` で送ってくる端末公開鍵 JWK をここに保存し、Phase 2 の
`/auth/dbsc/refresh` で発行するチャレンジ nonce の proof JWT 検証に利用する。
チャレンジ本体は別テーブル [dbsc_challenges](#dbsc_challenges) に保存。

| カラム                | 型      | NULL | デフォルト | 説明                                                                    |
| --------------------- | ------- | ---- | ---------- | ----------------------------------------------------------------------- |
| id                    | TEXT    | NO   | —          | UUID（PK）。セッション Cookie の payload に含まれる識別子               |
| user_id               | TEXT    | NO   | —          | FK → users.id（CASCADE）                                                |
| created_at            | INTEGER | NO   | —          | 作成時刻（unix 秒）                                                     |
| expires_at            | INTEGER | NO   | —          | 有効期限（unix 秒）。デフォルト 7 日                                    |
| revoked_at            | INTEGER | YES  | —          | 失効時刻。NULL なら未失効                                               |
| revoked_reason        | TEXT    | YES  | —          | 失効理由（`user_logout` / `security_event` / `admin_revoke` 等）        |
| user_agent            | TEXT    | YES  | —          | 監査用                                                                  |
| ip                    | TEXT    | YES  | —          | 監査用（CF-Connecting-IP）                                              |
| bff_origin            | TEXT    | NO   | —          | 発行元 BFF オリジン。DBSC バインド時に呼び出し元一致確認に使う          |
| device_public_key_jwk | TEXT    | YES  | —          | DBSC: 端末公開鍵 JWK（JSON 文字列、ES256 / P-256）。未バインドなら NULL |
| device_bound_at       | INTEGER | YES  | —          | DBSC: バインド成立時刻（unix 秒）。未バインドなら NULL                  |

### インデックス

| 名前                        | カラム     | 種別  | 備考                         |
| --------------------------- | ---------- | ----- | ---------------------------- |
| idx_bff_sessions_user_id    | user_id    | INDEX | ユーザー単位の一括失効・件数 |
| idx_bff_sessions_expires_at | expires_at | INDEX | 期限切れレコードの定期削除用 |

### 設計メモ

- 二重バインドは `bindDeviceKeyToBffSession` の WHERE `device_public_key_jwk IS NULL` でアトミックに排除
- 端末追加は新規ログイン経由のみ（既存セッションへの公開鍵上書き不可）
- 失効後 7 日経過したレコードは `cleanupStaleBffSessions` で削除（日次 cron 想定）
- DBSC 公開鍵を読み出す際は `parseStoredDbscPublicJwk` で kty/crv/d を再検証してから `importJWK` する

---

## dbsc_challenges

DBSC Phase 2 の challenge-response 方式で使用する短寿命 nonce を管理する。
`POST /auth/dbsc/refresh` で Chrome が最初に POST すると、IdP はここに nonce を登録し、`403`
応答の `Secure-Session-Challenge` ヘッダで Chrome に返す。Chrome は端末秘密鍵で nonce を
含む proof JWT を署名して再送 → IdP 側で `consumeDbscChallenge` により一回限り消費する。

### カラム

| カラム      | 型      | NULL | デフォルト | 説明                                                       |
| ----------- | ------- | ---- | ---------- | ---------------------------------------------------------- |
| nonce       | TEXT    | NO   | —          | 主キー。base64url な乱数（十分長いものを呼び出し側で担保） |
| session_id  | TEXT    | NO   | —          | `bff_sessions.id`（FK, CASCADE）                           |
| created_at  | INTEGER | NO   | —          | 発行時刻（unix 秒）                                        |
| expires_at  | INTEGER | NO   | —          | 有効期限（unix 秒、既定 60 秒 TTL）                        |
| consumed_at | INTEGER | YES  | —          | 消費済みマーキング（unix 秒）。未消費なら NULL             |

### インデックス

| 名前                           | カラム     | 種別    | 備考                             |
| ------------------------------ | ---------- | ------- | -------------------------------- |
| (PK) nonce                     | nonce      | PRIMARY | 一意制約でもリプレイを阻止       |
| idx_dbsc_challenges_session_id | session_id | INDEX   | セッション単位のクリーンアップ用 |
| idx_dbsc_challenges_expires_at | expires_at | INDEX   | 期限切れレコードの定期削除用     |

### 設計メモ

- 並行リフレッシュに備え、同一セッションで複数の未消費 nonce を許容（PK は nonce 単体）
- `consumeDbscChallenge` の WHERE で `consumed_at IS NULL AND expires_at > ? AND session_id = ?` を
  アトミックに絞り込むことで、リプレイ・期限切れ・セッション不一致を一本化して排除する
- `cleanupStaleDbscChallenges` は期限切れ／消費後 1 時間経過した行を削除（監査用に短期保持）

---

## D1 の制約事項

- **外部キー制約の変更不可**: `ALTER TABLE ... ADD CONSTRAINT` 非対応。FK変更はテーブル再作成が必要（マイグレーション 0004, 0005, 0018 参照）
- **CHECK制約の後付け不可**: 同上。テーブル再作成で対応（マイグレーション 0018 参照）
- **トランザクション**: D1 はシングルクエリでの暗黙トランザクションをサポートするが、複数クエリの明示トランザクションは `batch()` API を使用
- **日時型**: SQLite に `DATETIME` 型はなく、`TEXT`（ISO 8601）または `INTEGER`（Unix epoch）で格納。本スキーマでは主に TEXT を使用（mcp_sessions, revoked_access_tokens のみ INTEGER）

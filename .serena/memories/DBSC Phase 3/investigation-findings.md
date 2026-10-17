## DBSC Phase 3 現状調査結果（2026-04-19）

### 1. ActiveSession 型定義

- **所在**: `packages/shared/src/db/refresh-tokens.ts:238-244`
- **構造**: `id`, `service_id`, `service_name`, `created_at`, `expires_at` のみ
- **DBSC 関連フィールド**: 未搭載。DBSC バインド状態はここには含まれない。
- **注**: refresh_tokens.ts で定義されているため、IdP の refresh token 相当を表す（BFF セッションではない）。

### 2. BFF セッションスキーマ

- **所在**: `packages/shared/src/db/bff-sessions.ts`
- **テーブル**: `bff_sessions` （BFF セッション管理）
- **DBSC カラム**:
  - `device_public_key_jwk` (string | null): ES256 JWK JSON 文字列
  - `device_bound_at` (number | null): unix 秒タイムスタンプ
- **サマリー型**: `ActiveBffSessionSummary` インターフェース
  - `has_device_key` (boolean): JWK 有無フラグ（生値は返さない）
  - `device_bound_at` (number | null): バインド日時
  - その他: `id`, `user_id`, `created_at`, `expires_at`, `user_agent`, `ip`, `bff_origin`
- **リスト関数**: `listActiveBffSessionsByUserId()` — `created_at DESC` でソート

### 3. セッション一覧 API

- **IdP**: `workers/id/src/routes/users.ts:157` — `GET /api/users/me/tokens` は `listActiveSessionsByUserId()` を呼ぶ（refresh_tokens 側）
- **IdP 管理者向け**: `GET /api/users/:id/tokens` — refresh_tokens 側のセッション一覧
- **IdP 管理者向け BFF**: `GET /api/users/:id/bff-sessions` — `listActiveBffSessionsByUserId()` で DBSC バインド状態を返す（line 1072+）
- **User Worker**: `workers/user/src/routes/sessions.ts:16` — `GET /` は IdP `/api/users/me/tokens` に委譲
- **User Worker**: DELETE ルート（単一/全て失効）も実装済み

### 4. フロントエンド実装

- **User**: `workers/user/frontend/src/pages/sessions.astro` — 有効なセッション一覧表示ページ実装済み
  - API: `GET /api/me/sessions`
  - 型: `ActiveSession[]` （IdP より refresh token セッション）
  - UI: service_name/IdP 判別、作成日時・有効期限、1個ずつ無効化ボタン
  - 現在「現在のセッション」バッジなし（比較ロジック未実装）
- **Admin**: sessions ページ未実装（ファイルなし）

### 5. DBSC 実装ファイル（Phase 1/2 の位置）

- **IdP**: `workers/id/src/routes/auth/dbsc.ts` — `POST /auth/dbsc/bind`, `POST /auth/dbsc/challenge`, `POST /auth/dbsc/verify`
- **Admin/User BFF**: `workers/admin/src/routes/dbsc.ts`, `workers/user/src/routes/dbsc.ts` — `/auth/dbsc/start`, `/auth/dbsc/refresh`
- **Shared**: `bindDeviceKeyToBffSession()`, `issueDbscChallenge()`, `consumeDbscChallenge()`, `verifyDbscProofJwt()` など shared に実装済み

### 6. API ドキュメント

- **docs/api-user.md:27-28** — `/auth/dbsc/start`, `/auth/dbsc/refresh` 記載
- **docs/api-admin.md:26-27** — 同上
- **docs/api-id.md:56-58** — IdP の `/auth/dbsc/bind`, `/auth/dbsc/challenge`, `/auth/dbsc/verify` 記載
- **docs/api-id.md:101**, **docs/api-admin.md:99** — `GET /api/users/:id/bff-sessions` 記載（`has_device_key` / `device_bound_at` 含む）

### Phase 3 実装に必要な作業

1. **ActiveSession 型拡張**: `has_device_key`, `device_bound_at` フィールド追加（or 別の `ActiveBffSession` 型を使い分け）
2. **User API**: `/api/me/sessions` 応答に DBSC バインド状態を含める（BFF セッションと refresh_tokens の統合？）
3. **User フロントエンド**: sessions.astro で DBSC バッジ表示（device_bound_at の有無で判別）
4. **Admin フロントエンド**: sessions.astro 作成し、`/api/users/:id/bff-sessions` を呼んで表示

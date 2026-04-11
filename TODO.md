# TODO

## テストカバレッジ追加（2026-04-11）

- ✅ **`workers/mcp/src/index.test.ts`: MCPワーカー index のユニットテスト4件追加**
  - テストファイルが存在しなかった。health check・CORS・エラーハンドラを網羅
  - `GET /health`: 200 + status/worker/timestamp 確認（1件）
  - CORS: MCP_ORIGINと一致するoriginにACEO付与・不一致には付与しない（2件）
  - `onError` ハンドラ: 未処理例外で500 + INTERNAL_ERROR（1件）
  - mcp worker: 159 → 163テスト（+4）、全2091テストパス

## 残課題（要対応）

なし

## テストカバレッジ追加（2026-04-11）

- ✅ **`auth.test.ts`: rejectBannedUserMiddleware・rejectServiceTokenMiddleware のユニットテスト8件追加**
  - `rejectServiceTokenMiddleware`: user未設定→401・cidあり（サービストークン）→403・cidなし→next呼び出し（3件）
  - `rejectBannedUserMiddleware`: user未設定→401・DB例外→500・ユーザー未存在→401・BAN済み→401・正常→dbUser設定+next（5件）
  - id worker: 879 → 887テスト（+8）

## テストカバレッジ追加（2026-04-11）

- ✅ **`services.test.ts`: 未テスト4関数のユニットテスト15件追加**
  - `listServicesByOwner`: owner_user_id フィルター・ORDER BY created_at DESC・空配列（3件）
  - `updateServiceFields`: name単体・allowedScopes単体・両方同時・空フィールド→null・存在しないID（5件）
  - `rotateClientSecret`: 新ハッシュUPDATE・存在しないID→null・RETURNING *確認（3件）
  - `transferServiceOwnership`: オーナー変更・存在しないID→null・RETURNING *確認（3件）
  - packages/shared: 610 → 625テスト（+15）、全2055テストパス

## テストカバレッジ追加（2026-04-11）

- ✅ **`users.test.ts`: listUsers・countUsers の search フィルターテスト2件追加**
  - `listUsers`: search フィルター（email OR name の部分一致OR検索）SQL確認・bindパラメータ確認
  - `countUsers`: search フィルターで絞り込み件数・bindパラメータ確認（同一パターンを2回渡す仕様）
  - 全610テストパス（608 → 610、sharedパッケージ）

## テストカバレッジ追加（2026-04-11）

- ✅ **`token.test.ts`: resolveOAuthClient のテスト2件追加**
  - `authorization_code grant`: Basic認証ヘッダーのclient_idとbodyのclient_idが不一致 → 401 invalid_client
  - `refresh_token grant`: 同上（セキュリティ境界条件のカバレッジ追加）
  - 全879テストパス（id worker: 877 → 879）

- ✅ **`validation.test.ts`: UUID_RE のテスト13件追加**
  - `packages/shared/src/lib/validation.ts` のテストファイルが存在しなかった
  - 有効なUUID v4形式・大文字小文字区別なし・全ゼロ/全fのUUID（5件）
  - ハイフンなし・文字数過不足・空文字・無効文字・ハイフン位置違い・前後余分文字（8件）
  - 全2016テストパス（2003 → 2016）


## テストカバレッジ追加（2026-04-11）

- ✅ **`login-events.test.ts`: 未テスト3関数のテスト12件追加**
  - `getUserDailyLoginTrends`: 日別ログイン統計・空配列・days=30デフォルト・days=7指定・SQL確認（5件）
  - `getActiveUserStats`: DAU/WAU/MAU統計・nullフォールバック・3クエリ並列+SQL確認（3件）
  - `getDailyActiveUsers`: 日別アクティブユーザー・空配列・days=30デフォルト・SQL確認（4件）
  - 全2003テストパス（1991 → 2003）

## テストカバレッジ追加（2026-04-10）

- ✅ **`users.test.ts`: 未テスト6関数のテスト21件追加**
  - `findUserById`: id検索・null返却・SQL確認（3件）
  - `findUserByEmail`: email検索・null返却・SQL確認（3件）
  - `findUserBySub`: google/github providerでの検索・null返却・カラム名確認（4件）
  - `getDailyUserRegistrations`: 日別集計・空配列・daysパラメータ確認（3件）
  - `upsertGithubUser`: 既存更新・email連携・仮メール新規作成・DBnullエラー（4件）
  - `upsertTwitchUser`: 既存更新・email連携・仮メール新規作成・DBnullエラー（4件）
  - 全563テストパス（542 → 563）

## 2026-04-10 機能追加: MCPツール get_user_owned_services・get_user_authorized_services

### 追加したツール

#### workers/mcp/src/tools/users.ts ✅
- `getUserOwnedServicesTool` (`get_user_owned_services`): ユーザーが所有するサービス一覧を取得（削除前の所有権確認に有用）
- `getUserAuthorizedServicesTool` (`get_user_authorized_services`): ユーザーが認可済みのサービス（連携中）一覧を取得
- 両ツール: user_id 未指定・空文字→エラー、ユーザー未存在→404エラー
- テスト: 各4件追加（計+8件、151 → 159件）

## テストカバレッジ追加（2026-04-10）

- ✅ **`profile.test.ts`: `/login-stats`・`/data-export` 未テストエンドポイント テスト11件追加**
  - `workers/user/src/routes/profile.ts` の `GET /api/me/login-stats` と `GET /api/me/data-export` のテストが存在しなかった
  - `GET /login-stats`: セッションなし401・正常系・エンドポイント確認・days転送・daysパラメータなし・days=366→400・IdP500伝播（7件）
  - `GET /data-export`: セッションなし401・正常系・エンドポイント確認・IdP500伝播（4件）
  - 全197テストパス（186 → 197）

## テストカバレッジ追加（2026-04-10）

- ✅ **`transport.test.ts`: MCP transport ユニットテスト15件追加**
  - `workers/mcp/src/mcp/transport.ts`: テストファイルが存在しなかった。全エンドポイントを網羅
    - `POST /mcp`: 不正JSON→ParseError(-32700)・initialize→セッション作成+Mcp-Session-Idヘッダー・セッションIDなし→-32600・無効セッション→-32600・有効セッション→正常処理・Notification→202・全通知→202・バッチ→配列・id受け渡し確認（9件）
    - `GET /mcp`: セッションIDなし→400・無効セッション→400・有効セッション→SSE text/event-stream（3件）
    - `DELETE /mcp`: セッションIDあり→deleteMcpSession呼び出し+204・セッションIDなし→204（2件）
  - 全1932テストパス（1917 → 1932）

## テストカバレッジ追加（2026-04-10）

- ✅ **`server.test.ts`: McpServer クラスのユニットテスト12件追加**
  - `workers/mcp/src/mcp/server.ts`: テストファイルが存在しなかった。全メソッドを網羅
    - `initialize`: プロトコルバージョン・capabilities・serverInfo を返す（1件）
    - `ping`: 空のresultを返す（1件）
    - unknown method: Method not found エラーを返す（1件）
    - `tools/list`: 未登録時は空配列・登録済みツール一覧（2件）
    - `tools/call`: nameなし→エラー・未登録tool→エラー・正常呼び出し・argumentsなし・例外→isError・非Errorthrow（6件）
    - id の受け渡し確認（1件）
  - 全1917テストパス（1905 → 1917）

## セキュリティ対応（2026-04-10）

- ✅ **hono ^4.12.8 → ^4.12.12 アップデート（Dependabot alerts 対応）**
  - 対象アラート: GHSA-r5rp-j6wh-rvv4 / GHSA-26pp-8wgv-hjvm / GHSA-xpcf-pg52-r92g / GHSA-wmmm-f939-6g9c / GHSA-xf4j-xp2r-rqqx
  - 全ワークスペース（workers/id・admin・mcp・user・packages/shared）を更新
  - 全テスト（1905件）・typecheck パス確認済み

## テストカバレッジ追加（2026-04-10）

- ✅ **`auth.test.ts` / `rate-limit.test.ts`: MCP middleware ユニットテスト17件追加**
  - `workers/mcp/src/middleware/auth.ts`: テストファイルが存在しなかった。mcpAuthMiddleware（4件）・mcpRejectBannedUserMiddleware（5件）・mcpAdminMiddleware（3件）を網羅
    - Authorization ヘッダーなし・Bearer以外のスキーム・有効トークン・JWT検証失敗
    - ユーザー未認証・DB未登録・BAN済み・正常ユーザー・DB例外
    - 未認証・非admin・adminロール確認
  - `workers/mcp/src/middleware/rate-limit.ts`: テストファイルが存在しなかった。mcpRateLimitMiddleware（5件）を網羅
    - バインディング未設定でスキップ・成功・超過429・unknown IP・複数IP独立
  - 全1905テストパス（1888 → 1905）

## テストカバレッジ追加（2026-04-10）

- ✅ **`base64url.test.ts` / `helpers.test.ts` / `providers.test.ts`: ユニットテスト31件追加**
  - `packages/shared/src/lib/base64url.ts`: テストファイルが存在しなかった。decodeBase64Url のパディング・URLセーフ文字・JWT用途など9件
  - `packages/shared/src/db/helpers.ts`: テストファイルが存在しなかった。daysAgoIso の日数計算・月またぎ・now省略時・ISO形式確認 8件
  - `packages/shared/src/lib/providers.ts`: テストファイルが存在しなかった。isValidProvider・ALL_PROVIDERS・DISPLAY_NAMES・COLUMN・CREDENTIALS の全フィールド検証 14件
  - 全517テストパス（486 → 517）

## テストカバレッジ追加（2026-04-10）

- ✅ **`env-validation.test.ts`: validateEnv ユニットテスト15件追加**
  - `workers/id/src/utils/env-validation.ts` のテストファイルが存在しなかった
  - 必須フィールド（GOOGLE_CLIENT_ID/SECRET、JWT_PRIVATE/PUBLIC_KEY、IDP/USER/ADMIN_ORIGIN、COOKIE_SECRET）の検証
  - COOKIE_SECRET 32文字未満でエラー・ちょうど32文字でOK
  - オプションプロバイダー（LINE/GitHub/X）の片方設定でエラー・両方設定でOKのケース
  - 成功結果キャッシュ・失敗結果非キャッシュ・_resetValidationCache 動作確認

- ✅ **`mcp/well-known.test.ts`: Protected Resource Metadata エンドポイントテスト5件追加**
  - `workers/mcp/src/routes/well-known.ts` のテストファイルが存在しなかった
  - RFC 9728 Protected Resource Metadata の resource/authorization_servers/scopes_supported/bearer_methods_supported を検証
  - 環境変数 MCP_ORIGIN / IDP_ORIGIN が正しく反映されることを確認
  - 全1822テストパス（1802 → 1822）

## テストカバレッジ追加（2026-04-10）

- ✅ **`admin-audit-logs.test.ts`: getAuditLogStats・status フィルターのテスト10件追加**
  - `packages/shared/src/db/admin-audit-logs.test.ts` の `getAuditLogStats` が未テストだった
  - action_stats・admin_stats・daily_stats の返却値・SQL構造・days パラメータ・空配列ケース（8件）
  - `listAdminAuditLogs` の `status` フィルター単体・他フィルターとの複合（2件）
  - 全486テスト（shared）パス確認済み

## テストカバレッジ追加（2026-04-10）

- ✅ **`login-history.test.ts`: provider・境界値テスト7件追加**
  - `workers/user/src/routes/login-history.ts` の provider フィルターと limit/offset バリデーションのテストが未カバーだった
  - 有効provider（google/github）転送・無効provider（facebook）400・limit=0エラー・offset=-1エラー・provider+pagination組み合わせを網羅
  - 全186テストパス（login-history.test.ts: 8件 → 15件）

- ✅ **`sessions.test.ts`: DELETE /others テスト8件追加**
  - `workers/user/src/routes/sessions.ts` の「現在のセッション以外の全セッションを終了」エンドポイントにテストが存在しなかった
  - セッションなし401・IdP呼び出し確認・token_hash（SHA256(refresh_token)）送信・各ヘッダー確認・IdP応答伝播を網羅
  - 全180テストパス（sessions.test.ts: 16件 → 24件）

## 依存関係更新（2026-04-10）

- ✅ **vite 7.3.1 → 8.0.3 アップデート**
  - 全ワークスペース（workers/id・admin・mcp・user）の vite を 8.0.3 に更新
  - 全テスト（1779件）・typecheck パス確認済み

- ✅ **TypeScript 5.9.3 → 6.0.2 アップデート**
  - TS6.0 で `baseUrl` が deprecated になったため、全ワークスペースの tsconfig.json から `baseUrl` を削除
  - `packages/shared`: `baseUrl` と空の `paths: {}` を削除
  - `workers/admin/id/mcp/user`: `baseUrl: "."` を削除（`paths` は TS6.0 から単独指定可能）
  - 全 typecheck・全テスト（1779件）パス確認済み

## セキュリティ修正（2026-04-09）

### /auth/authorize DB例外時のRFC 6749エラー形式統一

- ✅ **`GET /auth/authorize`: `findServiceByClientId` / `listRedirectUris` を try-catch で囲み、DB障害時に `{ error: 'server_error', error_description: 'Internal server error' }` 500 を返す**
- **背景**: `/auth/authorize` は RFC 6749 形式（`{ error: '...', error_description: '...' }`）でエラーを返すが、DB例外がスローされると global `onError` ハンドラーが `{ error: { code: 'INTERNAL_ERROR' } }` 形式（非RFC 6749）を返す不一致があった。MCP クライアント等の OAuth 準拠クライアントがエラーレスポンスをパースできなくなる問題を修正
- **テスト**: DB例外テスト2件追加（全840テストパス）

## コードレビュー修正（2026-04-09）

### users.ts Promise.all DB例外ハンドリング追加

- ✅ **`GET /api/users/me/data-export`: `Promise.all` を try-catch で囲み、DB障害時に `INTERNAL_ERROR` 500 を返す**
- ✅ **`GET /api/users/me/security-summary`: 同上（`INTERNAL_ERROR` 500 を返す）**
- ✅ **`GET /api/users`: 管理者ユーザー一覧の `Promise.all` も同様に修正**
- **背景**: `metrics.ts` で同パターン修正済みだったが、`users.ts` の3エンドポイントで漏れていた。DB障害時に JSON レスポンスなしで 500 が素通りしていた
- **テスト**: DB例外テスト3件追加（全832テストパス）

## セキュリティ修正（2026-04-09）

- ✅ **MCPワーカー `transport.ts`: `c.req.json()` のtry-catchなし問題を修正 → JSON-RPC ParseError(-32700)を正しく返却**
- ✅ **MCPワーカー `rate-limit.ts`: IPベースのレートリミッターミドルウェア新規追加 (60リクエスト/分)**
- ✅ **MCPワーカー `index.ts`: レートリミットを認証より前に適用するよう設定**
- ✅ **MCPワーカー `wrangler.toml`: `RATE_LIMITER_MCP` バインディング追加**


## コードレビュー修正（2026-04-09）

- ✅ **`device.ts`: `POST /code` および `handleDeviceCodeGrant` のDB例外ハンドリング追加**
  - `findServiceByClientId` 等のDBアクセスを try/catch で囲み、500エラーを適切に返すよう修正

- ✅ **`token.ts`: `handleRefreshTokenGrant` の `refreshScope` undefined フォールバック追加**
  - `resolveEffectiveScope(null, ...)` が undefined を返すケースに `?? ''` を追加

- ✅ **`metrics.ts`: `/login-trends`・`/user-registrations` の `parseDays` 統一（maxDays: 365）**
  - 手書きの `parseInt` + `Math.min/max` ロジックを `parseDays` に置き換え

- ✅ **`well-known.ts`: OIDC Discovery Document に `end_session_endpoint` を追加**
  - `${issuer}/auth/logout` を `end_session_endpoint` として公開（OIDC Discovery 1.0 RECOMMENDED）

- ✅ **セキュリティ調査: UUID/推測困難な値での認可代替パターン（問題なし）**
  - device verify: `authMiddleware` による JWT 認証必須を確認
  - external API: `serviceAuthMiddleware` による client_secret 認証必須を確認
  - admin API: `adminMiddleware` による role チェック必須を確認
  - auth code: `findAndConsumeAuthCode` によるワンタイム消費を確認

## バグ修正・テスト追加（2026-04-09）

- ✅ **Authorization Code Flow E2E テスト2件追加（State Cookie Round-trip）**
  - `/auth/login → /auth/callback → /auth/exchange` の完全なBFFフロー検証
  - CSRF攻撃シミュレーション（state不一致で400を返すことを確認）
  - `timingSafeEqual` を実際の文字列比較でモックし、idState の round-trip を検証
  - 全821テストパス確認済み

- ✅ **`auth.ts`: `/auth/exchange` ユーザー不存在時レスポンス修正**
  - `400 { error: 'invalid_grant' }` → `404 { error: { code: 'NOT_FOUND' } }` に統一
  - API設計規約に準拠（標準エラーフォーマット）

- ✅ **`token.ts`: `/api/token/introspect` 認証失敗レスポンス修正**
  - `{ error: 'invalid_client' }` → `{ active: false }` に変更（RFC 7662 準拠）
  - `WWW-Authenticate: Basic realm="0g0-id"` ヘッダーは引き続き設定

## テストカバレッジ追加（2026-04-08）

- ✅ **`service-auth.ts`: authenticateService / serviceAuthMiddleware ユニットテスト13件追加**
  - `workers/id/src/utils/service-auth.test.ts` を新規作成
  - `authenticateService`: ヘッダーなし・非Basicスキーム・無効Base64・コロンなし・サービス未発見・シークレット不一致・コロン複数・正常認証・DB障害（9テスト）
  - `serviceAuthMiddleware`: DB障害→500・認証失敗→401・ヘッダーなし→401・正常認証→serviceをcontext設定（4テスト）
  - 全1677テストパス

## バグ修正・RFC準拠改善（2026-04-08）

- ✅ **`metrics.ts`: Promise.allにtry-catch追加**
  - `GET /api/metrics` のDB並列呼び出しが例外ハンドリングなしで500素通りしていた
  - `{ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch metrics' } }` を500で返すよう修正

- ✅ **`pagination.ts` / `metrics.ts`: parseDaysのエラーレスポンス形式統一**
  - `{ error: string }` 形式だったのを `{ error: { code: 'INVALID_REQUEST', message: '...' } }` に統一
  - 全workspace型チェック・736テストパス確認済み

- ✅ **`device.ts`: `expired_token` → `invalid_grant`（RFC 8628 §3.5準拠）**
  - `expired_token` は RFC 6749 token エンドポイントの標準エラーコードリストに含まれないため `invalid_grant` に変更
  - `error_description: 'Device code has expired'` を付与

- ✅ **`device.ts`: `/verify` エンドポイントのtry-catch漏れ修正**
  - `findDeviceCodeByUserCode` / `findServiceById` 呼び出しがtry-catchなしでDBエラー素通り
  - 500時に `{ error: 'INTERNAL_ERROR' }` を返すよう修正

- ✅ **`device.ts`: `/code` エンドポイントの `invalid_client` ステータスコード統一**
  - `400` → `401`（`handleDeviceCodeGrant` の同エラーと統一、RFC 6749 §5.2推奨）

- ✅ **`/verify` エンドポイントのテストカバレッジ追加**
  - IdP側（`workers/id`）での approve/deny/期限切れ/承認済み/拒否済み状態のテストを追加
  - 各状態の正常系・異常系を網羅的にカバー（2026-04-08）

- ✅ **`users.ts` の `PATCH /:id/role` / `PATCH /:id/ban` の自己変更ガード調査**
  - アクセストークンの `sub` は内部UUID（ペアワイズsubではない）であることを確認
  - `tokenUser.sub`（内部UUID）と `targetId`（内部UUID）は同じ空間で比較されており、バグなし
  - 自己変更ガードは正しく機能している（2026-04-08）

- ✅ **`metrics/active-users`・`metrics/active-users/daily` のテストカバレッジ追加（11ケース、2026-04-08）**
  - `parseDays` エラーパス含む正常系・異常系を網羅
  - `GET /api/metrics/active-users` および `GET /api/metrics/active-users/daily` の全ケースカバレッジ追加

- ✅ **`device-codes.ts`: デバイスコード管理関数のテスト21件追加（2026-04-08）**
  - `packages/shared/src/db/device-codes.test.ts` を新規作成
  - `createDeviceCode`: INSERT・scope null対応（2テスト）
  - `findDeviceCodeByUserCode`: 正常系・null返却・bindアサーション（3テスト）
  - `findDeviceCodeByHash`: 正常系・null返却・bindアサーション（3テスト）
  - `approveDeviceCode`: approved_at/user_id設定確認（1テスト）
  - `denyDeviceCode`: denied_at設定確認（1テスト）
  - `tryUpdateDeviceCodePolledAt`: true/false・meta.changes undefined・SQL・bindアサーション（4テスト）
  - `deleteDeviceCode`: DELETE SQL確認（1テスト）
  - `deleteApprovedDeviceCode`: true/false・SQL条件・bindアサーション（3テスト）
  - `deleteExpiredDeviceCodes`: SQL確認・run呼び出し（1テスト）
  - 全1662テストパス

## バグ修正（2026-04-09）

- ✅ **`security.ts`: parseDays maxDays 不一致バグ修正 + login-trends テスト追加**
  - `GET /api/me/security/login-stats` / `GET /api/me/security/login-trends` で `parseDays` のデフォルト `maxDays: 90` を使用していた
  - IdP 側は `maxDays: 365` のため、`days=100〜365` の有効リクエストを BFF が誤って 400 拒否するバグを修正
  - `parseDays` 呼び出しを `{ maxDays: 365 }` に統一
  - `profile.ts` の同種バグ (`message: daysResult.error` → `message: daysResult.error.message`) も修正
  - `security.test.ts`: `login-trends` エンドポイントのテスト7件追加
  - `security.test.ts`: `login-stats` に days=100 通過・days=366 拒否テスト2件追加
  - 全 1730 テストパス

## コードレビュー修正（2026-04-10）

### services.ts 全エンドポイントにDB例外ハンドリング追加

- ✅ **`GET /api/services`: `Promise.all([listServices, countServices])` を try-catch で囲み、DB障害時に `INTERNAL_ERROR` 500 を返す**
- ✅ **`GET /api/services/:id`: `findServiceById` を try-catch で囲み、DB障害時に `INTERNAL_ERROR` 500 を返す**
- ✅ **`POST /api/services`: `createService` を try-catch で囲み、DB障害時に `INTERNAL_ERROR` 500 を返す**
- ✅ **`PATCH /api/services/:id`: `updateServiceFields` を try-catch で囲み、DB障害時に `INTERNAL_ERROR` 500 を返す**
- ✅ **`DELETE /api/services/:id`: `findServiceById`、`revokeAllServiceTokens`、`deleteService` をそれぞれ try-catch で囲む**
- ✅ **`GET /api/services/:id/redirect-uris`: `findServiceById` と `listRedirectUris` を `Promise.all` + try-catch で統合**
- ✅ **`POST /api/services/:id/redirect-uris`: `findServiceById` を try-catch で囲む**
- ✅ **`POST /api/services/:id/rotate-secret`: `findServiceById`、`rotateClientSecret` を try-catch で囲む**
- ✅ **`PATCH /api/services/:id/owner`: `findServiceById` + `findUserById` を `Promise.all` + try-catch で統合、`transferServiceOwnership` も try-catch で囲む**
- ✅ **`GET /api/services/:id/users`: `findServiceById` + `Promise.all([listUsers, countUsers])` を try-catch で統合**
- ✅ **`DELETE /api/services/:id/users/:userId`: `findServiceById` + `findUserById` を `Promise.all` + try-catch で統合、`revokeUserServiceTokens` も try-catch で囲む**
- ✅ **`DELETE /api/services/:id/redirect-uris/:uriId`: `findServiceById` + `findRedirectUriById` を `Promise.all` + try-catch で統合、`deleteRedirectUri` も try-catch で囲む**
- **テスト**: DB例外テスト11件追加（全852テストパス）
- **背景**: `createAdminAuditLog` の try-catch は対応済みだったが、主要なビジネスロジックのDBアクセスが未保護で、D1障害時に非JSON500が素通りしていた

## 残課題（要対応）

なし

## 依存関係更新（2026-04-10）

- ✅ **vitest 3.2.4 → 4.1.4 アップデート**
  - vitest 4.x で describe() をテスト関数内から呼び出す制約が追加
  - `packages/shared/src/db/refresh-tokens.test.ts` の describe ネスト構造バグを修正
  - 全テストパス（852 + 477 + 195 + 83 + 172 = 1779 件）

## 依存関係更新（2026-04-10）

- ✅ **jose 6.2.1 → 6.2.2 アップデート**
  - JWEInvalid エラーによる不正な decompression 失敗の修正（セキュリティ修正）
  - workers/id, workers/mcp, packages/shared の 3 パッケージを更新
  - 全テストパス（852 + 475 + 195 + 172 + 83 件）

- ✅ **cloudflare グループ 3 パッケージ更新**
  - @cloudflare/workers-types: 4.20260317.1 → 4.20260409.1
  - @cloudflare/vite-plugin: 1.29.1 → 1.31.2（I/O コンテキストエラー修正含む）
  - wrangler: 4.75.0 → 4.81.1
  - workers/admin, workers/id, workers/mcp, workers/user, packages/shared 全ワークスペース更新
  - 全テストパス確認済み

## コードレビュー修正（2026-04-09）

### userinfo.ts / admin-audit-logs.ts DB例外ハンドリング追加

- **問題**: `findUserById`（userinfo.ts）、`getAuditLogStats` / `listAdminAuditLogs`（admin-audit-logs.ts）がtry-catchなしでDB呼び出しており、DB障害時に例外がそのままスローされていた
- **修正**:
  - `userinfo.ts`: `findUserById` を try-catch で囲み、DB例外時に `{ error: 'server_error' }` 500 を返す
  - `admin-audit-logs.ts`: 両DB関数を try-catch で囲み、DB例外時に `{ error: { code: 'INTERNAL_ERROR' } }` 500 を返す
  - `admin-audit-logs.ts`: `admin_user_id` / `target_id` のUUID形式バリデーション追加（IdP側にも多層防御として適用）
  - `admin-audit-logs.ts`: `action` パラメータの形式バリデーション追加（`^[a-z]+\.[a-z_]+$`）
- **テスト追加**: 計6件（DB例外→500 × 3、非UUID→400 × 2、不正action→400 × 1）
- **全829テストパス確認**

## セキュリティ修正（2026-04-09）

### admin BFF: /api/users/:id UUID形式バリデーション追加

- **問題**: `audit-logs.ts` にはUUID形式検証があったが、`users.ts` の `:id` パラメータには検証がなく不一致
- **修正**: `workers/admin/src/routes/users.ts` に UUID 検証ミドルウェアを追加
  - `/:id` および `/:id/*` 全ルートに適用（認証前にバリデーション）
  - `DELETE /:id/tokens/:tokenId` の `tokenId` も UUID 検証を追加
- **テスト**: 各エンドポイントに「非UUID形式のIDで400を返す」ケース追加（計12件）
- **全テストパス確認**: admin 195件, user 172件, id 823件

## 対応済み（2026-04-09）

- ✅ **`auth.ts` `/auth/callback`: OAuthコールバックエラーをBFFへリダイレクト転送（RFC 6749 §4.1.2.1）**
  - state cookieが有効な場合はBFFのredirectTo URLへ error/state パラメータ付きでリダイレクト
  - 未知のエラーコードはaccess_deniedにサニタイズ（内部情報漏洩防止）
  - cookie無効/未設定の場合はJSONエラーフォールバック
  - テスト2件追加（全823テストパス）

- ✅ **dependabot: hono 4.12.8 → 4.12.12 アップデート（5件のmoderate脆弱性修正）**
  - GHSA-26pp-8wgv-hjvm: setCookie() クッキー名バリデーション欠如
  - GHSA-r5rp-j6wh-rvv4: getCookie() ノーブレークスペースバイパス
  - GHSA-xpcf-pg52-r92g: ipRestriction() IPv4マップドIPv6誤判定
  - GHSA-xf4j-xp2r-rqqx: toSSG() パストラバーサル
  - GHSA-wmmm-f939-6g9c: serveStatic 連続スラッシュミドルウェアバイパス
  - `npm audit` 0件確認済み

## テストカバレッジ追加（2026-04-09）

- ✅ **`token-recovery.ts` / `refresh-token-rotation.ts`: ユニットテスト14件追加**
  - `workers/id/src/utils/token-recovery.test.ts` を新規作成（5テスト）
    - `reuse_detected` トークン → unrevokeRefreshToken 未呼び出し
    - null トークン → unrevokeRefreshToken 呼び出し
    - `rotation` トークン → unrevokeRefreshToken 呼び出し
    - `unrevokeRefreshToken` が false を返しても例外なし
    - DB例外時も reject せず resolve
  - `workers/id/src/utils/refresh-token-rotation.test.ts` を新規作成（9テスト）
    - `validateAndRevokeRefreshToken`: 正常系・未存在・TOKEN_ROTATED（30秒以内）・TOKEN_REUSE（30秒超）・rotation以外失効
    - `issueTokenPairWithRecovery`: 成功・TOKEN_REUSE・INTERNAL_ERROR（rotation）・INTERNAL_ERROR（null）
  - 全1701テストパス

- ✅ **`token-pair.ts`: `issueTokenPair` / `buildTokenResponse` のユニットテスト20件追加（全819テストパス）**
  - accessToken/refreshToken の返却確認
  - signAccessToken へのペイロード検証（iss/sub/aud/email/role/scope/cid）
  - clientId 有無による pairwiseSub の生成/null
  - familyId の明示指定と自動生成（randomUUID）
  - expiresAt が REFRESH_TOKEN_TTL_MS 後の ISO 文字列
  - tokenHash として sha256(refreshToken) が使われる
  - scope/serviceId null の正しいパススルー
  - buildTokenResponse: id_token/scope の条件付き付与、expires_in=900

## コードレビュー（2026-04-09）

- ✅ **`services.ts`: `createAdminAuditLog` try-catch 統一**
  - `service.create` / `service.update` / `service.secret_rotated` / `service.owner_transferred` の4ハンドラで try-catch なしだった
  - `service.delete` / `service.redirect_uri_added` 等と不一致を解消
  - テスト4件追加（監査ログ失敗時も本来のレスポンスを返すことを確認）
  - 全1681テストパス

## コードレビューで発見した問題（2026-04-08）

**セキュリティ（要確認）**
- ✅ `token.ts` `/api/token/revoke`: `cid` クレームが未設定の旧トークンでリボークが機能しない問題 → `payload.cid &&` を追加してintrospectと同じ設計に統一（コミット: `275d01e`）
- ✅ `auth.ts` `isAllowedRedirectTo`: Public Suffix List非対応（現状の `0g0.xyz` では問題なし、ドメイン変更時に潜在的 open redirect）→ `tldts` 導入・`allowPrivateDomains: true` で完全PSL対応済み（コミット: `5ef3b34`、テスト781件パス）
- ✅ `auth.ts` `/auth/refresh`: ユーザー未存在時に 404 を返している（RFC 6749 準拠なら 401 `invalid_grant`）→ 修正済み

**リファクタリング**
- ✅ `auth.ts` + `token.ts`: リフレッシュトークンのリプレイ攻撃検知・ローテーションロジックが重複 → `validateAndRevokeRefreshToken` / `issueTokenPairWithRecovery` ユーティリティへ抽出済み（2026-04-08）
- ✅ `auth.ts`: `/login` ハンドラの statePayload に `OAuthStateCookieData` 型注釈を明示（インライン無型オブジェクトを型安全な変数に分離、2026-04-08）
- ✅ `auth.ts`: `oauthError` ヘルパーと `c.json({ error: ... })` 直接使用の混在を解消（2026-04-08）
  - `/callback` の `createAuthCode` 失敗 → `{ error: { code: 'SERVER_ERROR', message } }` 形式に統一
  - `/refresh` のユーザー不存在 → `{ error: { code: 'INVALID_GRANT', message } }` 形式に統一
  - 対応テスト更新済み

**テスト**
- ✅ `token.ts` `handleRefreshTokenGrant`: パブリッククライアントのリフレッシュトークンフローにPKCE相当の保護がないことのテスト追加・仕様決定（2026-04-08）
  - 仕様決定: PKCEはauthorization_codeグラントの認可コード横取り攻撃対策であり、refresh_tokenグラントには適用されない
  - OAuth 2.1 §6.1 / RFC 6749 §6 に基づき、リフレッシュトークンフローの保護はローテーション + reuse detectionで実現
  - パブリッククライアント（PKCE不要）+ コンフィデンシャルクライアント（Basic認証）の両経路をテストで明示化（計2ケース追加）
  - 全102テスト（token.test.ts）パス確認済み

## テストカバレッジ追加（2026-04-07）

- ✅ **`mcp-sessions.ts`: MCPセッション管理関数のテスト18件追加**
  - `packages/shared/src/db/mcp-sessions.test.ts` を新規作成
  - `createMcpSession`: INSERT・パラメーターバインド・created_at/last_active_at 同一タイムスタンプ確認（3テスト）
  - `validateAndRefreshMcpSession`: 有効セッション→true・期限切れ→false・SQL確認・bind確認（5テスト）
  - `deleteMcpSession`: DELETE by id・SQL確認（3テスト）
  - `deleteMcpSessionsByUser`: DELETE by user_id・SQL確認（3テスト）
  - `cleanupExpiredMcpSessions`: DELETE・cutoff値確認・void確認（4テスト）
  - 全1591テストパス

- ✅ **`revoked-access-tokens.ts`: JTIブロックリスト関数のテスト11件追加**
  - `packages/shared/src/db/revoked-access-tokens.test.ts` を新規作成
  - `addRevokedAccessToken`: INSERT OR IGNORE の冪等性・パラメーターバインド（3テスト）
  - `isAccessTokenRevoked`: ブロックリストヒット/ミス・期限切れフィルタ・SQLアサーション（4テスト）
  - `cleanupExpiredRevokedAccessTokens`: 削除件数・meta.changes undefined ケース（4テスト）
  - 全1573テストパス

## セキュリティ修正・RFC準拠改善（2026-04-07, コードレビュー起因②）

- ✅ **`/auth/authorize`: `code_challenge` フォーマット検証追加（RFC 7636 §4.2）**
  - S256 の `code_challenge` は `BASE64URL(SHA256(code_verifier))` = 43文字の Base64url 文字列
  - `/^[A-Za-z0-9\\-_]{43}$/` で不正フォーマットを早期拒否（ストレージ DOS 対策）
  - テスト2件追加（短すぎる・長すぎる code_challenge）

- ✅ **`/api/token`: JSON ボディの非 string 値をフィルタリング**
  - `Record<string, string>` 型アサーションのみで実行時バリデーションがなかった
  - `typeof value === 'string'` チェックで配列・数値等を除外（urlencoded ブランチと統一）
  - テスト1件追加（配列型 grant_type → unsupported_grant_type）

- ✅ **`/api/token/introspect`: DB 例外時レスポンスを `{ error: 'server_error' }` に統一**
  - `{ active: false }` + 500 はクライアントに「トークン無効」と誤解させる（RFC 7662 違反）
  - `{ error: 'server_error' }` + 500 に変更（`/api/token/revoke` の DB エラー対応と統一）
  - テスト1件追加
  - 全1562テストパス

## バグ修正・RFC準拠改善（2026-04-07, 追記）

- ✅ **`/api/token/revoke`: DB例外時に `invalid_client` (RFC違反) → `server_error` 500 に修正**
  - `authenticateService` が例外をスローした場合、ステータス500なのに `invalid_client` を返していた（RFC 6749 §5.2 違反）
  - `{ error: 'server_error' }` 500 に修正
  - テスト1件追加（findServiceByClientId throws → server_error 500）

- ✅ **`handleAuthorizationCodeGrant`: `code_verifier` 必須チェックを RFC 7636 §4.4 準拠に修正**
  - `code_verifier` を無条件で必須チェックしていたため、PKCE を使わないコンフィデンシャルクライアントが弾かれていた
  - `authCode.code_challenge` が存在する場合のみ `code_verifier` を必須化するよう変更
  - テスト1件追加（Confidentialクライアント + code_challenge なし + code_verifier 未送信 → 200 成功）

- ✅ **`/auth/link-intent`: catch ブロックにログ追加**
  - `createAuthCode` 失敗時の catch ブロックで `authLogger.error` が呼ばれていなかった
  - `authLogger.error('[link-intent] Failed to create link token', err)` を追加（他エンドポイントと統一）

## セキュリティ修正・コードレビュー対応（2026-04-07, 追記）

- ✅ **`/auth/logout`: アクセストークン未失効バグ修正**
  - Authorization ヘッダーの Bearer トークンを `verifyAccessToken` で検証後、`addRevokedAccessToken` で失効
  - ログアウト後最大15分間アクセストークンが有効だった状態を解消
  - JWT検証失敗時は無視してログアウト自体は成功（`/api/token/revoke` と同パターン）
  - テスト3件追加（有効トークン/無効トークン/ヘッダーなし）

- ✅ **`/api/token/introspect`: `WWW-Authenticate` ヘッダー修正**
  - `Bearer realm=\"0g0-id\"` → `Basic realm=\"0g0-id\"` （RFC 7662準拠）
  - introspect は Basic 認証を使うため Bearer は誤りだった
  - テスト更新: `Basic` ヘッダーの返却を明示的に検証

## テストカバレッジ追加 + セキュリティ修正（2026-04-07, 追記）

- ✅ **cookie.ts: HMAC署名ユーティリティのテスト20件追加 + バグ修正**
  - `packages/shared/src/lib/cookie.test.ts` を新規作成
  - signCookie: 8テスト（形式・URLセーフ・決定性・JSON・特殊文字等）
  - verifyCookie: 12テスト（ラウンドトリップ・改ざん検知・エッジケース等）
  - バグ修正: `verifyCookie` の `!payloadEncoded` チェックを削除
    - 空文字列ペイロードが誤って null を返していた（falsy 判定の誤用）
  - 全1553テストパス

- ✅ **vite 7.3.1 → 7.3.2 へアップデート（Dependabot脆弱性対応）**
  - GHSA-4w7w-66w2-5vf9: Path Traversal in Optimized Deps `.map` Handling（High）
  - GHSA-v2wj-q39q-566r: `server.fs.deny` bypassed with queries（High）
  - GHSA-p9ff-h696-f583: Arbitrary File Read via Vite Dev Server WebSocket（Moderate）
  - `npm audit` で0件を確認済み

## バグ修正・コードレビュー対応（2026-04-07, 追記）

- ✅ **oauth.ts: state/nonce パラメータ長上限を IdP 側と統一**
  - `state`: 2048 → 1024 文字（auth.ts の `/auth/authorize` と一致）
  - `nonce`: 2048 → 128 文字（scopes.ts の `validateNonce` と一致）
  - BFF で緩い値を許容していたため、IdP で拒否される入力を渡してしまう可能性があった
  - 境界値テスト4件追加（正常/異常各2件）

- ✅ **テストモック不備修正（HMAC Cookie 導入後の欠落）**
  - `auth.test.ts`: `signCookie`/`verifyCookie` モック追加（各 `beforeEach` 内で再設定）
  - `auth.test.ts`: `findRefreshTokenById` モック追加（`attemptUnrevokeToken` 経由で try-catch に飲まれていた）
  - `token.test.ts`: `signCookie`/`verifyCookie`/`findRefreshTokenById` モック追加
  - 全1533テストパス（修正前: 20件以上失敗）

## バグ修正（2026-04-07）

- ✅ **MCP `deleteServiceTool`: サービス削除前にトークン失効が抜けていた**
  - `revokeAllServiceTokens('service_delete')` を `deleteService` 呼び出し前に追加（REST API と同じ挙動に統一）
  - 失効件数を監査ログの `details.revoked_token_count` と成功メッセージに含める
  - テスト2件追加（失効件数 0 件・5 件のケース）
  - 全1529テストパス

## リファクタリング（2026-04-07, コードレビュー起因）

- ✅ **`PATCH /api/users/me` の `name` フィールドをオプション化（部分更新対応）**
  - `PatchMeSchema` の `name` を `.optional()` に変更。全フィールド未指定時は refine で 400 を返す
  - `updateUserProfile` の型を `name?: string` に変更。`name` が未指定の場合は SET 句から除外
  - 空の更新パラメータ `{}` に対して `'No fields to update'` エラーを追加
  - テスト追加: nameなし部分更新・フィールド未指定エラーケース
  - 全1528テストパス

## バグ修正（2026-04-06, コードレビュー起因）

- ✅ **MCPツール createServiceTool: `allowed_scopes` がスペース区切り文字列になっていたバグを修正**
  - `(params.allowed_scopes as string[]).join(' ')` → `JSON.stringify(params.allowed_scopes as string[])` に変更
  - デフォルト値も `'openid profile email'` → `JSON.stringify(['openid', 'profile', 'email'])` に修正
  - `parseAllowedScopes` はJSON配列形式を期待するため、MCPで作成したサービスのスコープが常に空配列として扱われていた
  - テスト修正（`'openid email'` → `'[\"openid\",\"email\"]'`）+ デフォルト値確認テスト追加

## セキュリティ / アーキテクチャ課題

### ~~[高] MCPセッションのインメモリ管理がWorkerスケールアウトに非対応~~ ✅

- **対応済み**: `mcp_sessions` テーブルをD1に追加（migration 0019）し、`transport.ts` のインメモリ `Map` をD1永続化に置き換え。`packages/shared/src/db/mcp-sessions.ts` にCRUD関数を追加し、id workerのCron Triggerで期限切れセッションを自動削除

### ~~[高] Dependabot脆弱性アラート（high 1件、moderate 1件）~~ ✅

- **対応済み**: picomatch@4.0.3 → 4.0.4 へアップデート
  - ReDoS脆弱性（GHSA-c2c7-rcm5-vvqj, High, CVSS 7.5）修正
  - POSIXキャラクタークラスのMethod Injection（GHSA-3v7f-55p6-f55p, Moderate）修正
  - vitest・viteの間接依存。`npm audit`で0件を確認済み

### ~~[中] 管理者ルートにBANチェックミドルウェアが未適用~~ ✅

- **対応済み**: `adminMiddleware` 内でDB問い合わせによるBANチェックを追加。全管理者ルートでBANされたユーザーのアクセスを即時遮断

### ~~[中] /auth/exchange と /auth/refresh が Service Bindings 保護なし~~ ✅

- **対応済み**: `serviceBindingMiddleware` を追加。`INTERNAL_SERVICE_SECRET` 環境変数による共有シークレット検証で、BFF以外の外部からの直接呼び出しをブロック。サービスOAuth（Basic認証）は引き続き許可

### ~~[低] /auth/logout が認証なしでアクセス可能~~ ✅

- **対応済み**: `serviceBindingMiddleware` を追加。`/auth/exchange` や `/auth/refresh` と同様に、BFF以外の外部からの直接呼び出しをブロック

### ~~[低] 使用済み認可コードの定期クリーンアップ~~ ✅

- **対応済み**: Cron Trigger（毎日0時UTC）で期限切れ・消費済みの認可コードとデバイスコードを自動削除。`cleanupExpiredAuthCodes`を`auth-codes.ts`に追加、`workers/id`のscheduledハンドラから実行

### ~~[低] 既存テストの不備（services, users テスト）~~ ✅

- **対応済み**: 両テストファイルの`beforeEach`にadminMiddleware用`findUserById`モックを追加。admin系ルートの「ユーザー不在」テストは`mockResolvedValueOnce`チェーンでadminMiddlewareとルートハンドラを分離。`admin.test.ts`のenv未設定も修正。全1286テストがパス

### ~~[低] matchRedirectUri で localhost 時に query string が無視される~~ ✅

- **対応済み**: `regUrl.search === reqUrl.search` を localhost 比較ロジックに追加。ポートは無視しつつ query string は厳密に比較するよう修正（2026-04-04）

### ~~[低] 既存テストの不備（admin-audit-logs, metrics テスト）~~ ✅

- **対応済み**: 両テストファイルの `vi.mock` に `findUserById` を追加し、`beforeEach` でBANされていない管理者ユーザーを返すモックを設定。全57テストがパス

### ~~[低] Device Code Grant の user_code ブルートフォース耐性~~ ✅

- **対応済み**: 認証ユーザー単位のレートリミッター `RATE_LIMITER_DEVICE_VERIFY` を追加（10回/分/ユーザー）。既存のIP単位レートリミット（30回/分）と二重防御でブルートフォースを緩和

### ~~[中] authorization_code grantでID tokenが発行されない（OIDC非準拠）~~ ✅

- **対応済み**: `handleAuthorizationCodeGrant` で `openid` スコープがある場合に `signIdToken` を呼び出すよう修正。device code grantと同じパターンでpairwise sub + nonce対応

### ~~[中] token exchangeでredirect_uriが正規化されない~~ ✅

- **対応済み**: `handleAuthorizationCodeGrant` で `normalizeRedirectUri` を呼び出してから `matchRedirectUri` で比較するよう修正（RFC 6749 §4.1.3準拠）

### ~~[中] /auth/loginと/auth/authorizeでredirect_uri検証が不一致~~ ✅

- **対応済み**: `/auth/login` の `isValidRedirectUri`（完全一致DB検索）を `listRedirectUris` + `matchRedirectUri`（ポート番号無視のlocalhost比較）に置換。`/auth/authorize` と同一ロジックに統一（RFC 8252 §7.3準拠）

### ~~[低] isBffSessionでnameの空文字チェック漏れ~~ ✅

- **対応済み**: `isBffSession` type guardで `name` フィールドにも空文字チェック（`!u['name']`）を追加。他のフィールド（access_token, id, email等）と整合

### ~~[低] fetchWithAuthのリフレッシュレスポンス未バリデーション~~ ✅

- **対応済み**: `fetchWithAuth` でリフレッシュレスポンスの `access_token`/`refresh_token` が非空文字列であることを実行時バリデーション。不正な場合はセッションCookieを削除して401を返す

### ~~[低] MCPセッションTTLが固定期限（スライディングウィンドウでない）~~ ✅

- **対応済み**: セッションに `lastActiveAt` フィールドを追加し、リクエストごとに更新。TTL判定を `createdAt` から `lastActiveAt` に変更してアイドルタイムアウト方式に

### ~~[低] MCP list_usersのsearchがemailのみ（説明と不一致）~~ ✅

- **対応済み**: `UserFilter` に `search` フィールドを追加し、`buildUserFilterClause` でemail OR nameの部分一致検索を実装。MCPツールのhandlerを `filter.search` に変更

### ~~[情報] matchRedirectUri の localhost/127.0.0.1 混在~~ ✅

- **対応済み**: hostname比較を削除し、`localhost` と `127.0.0.1` を同一ホストとして扱うよう変更（RFC 8252 §8.3 SHOULD準拠）。テスト2件追加（2026-04-04）

### ~~[低] Device Code Grant: approved_at / user_id のデータ不整合エッジケース~~ ✅

- **対応済み**: DB CHECK制約 `CHECK (approved_at IS NULL OR user_id IS NOT NULL)` を追加（migration 0018）

## 軽微な改善候補（低優先度）

### ~~[低] introspect エンドポイントの `token_type_hint` が未活用~~ ✅

- **対応済み**: `token_type_hint === 'access_token'` のとき JWT を先に検証し、失敗時はリフレッシュトークンにフォールバックする分岐を追加。`introspectRefreshToken` / `introspectJwtToken` ヘルパー関数に切り出してリファクタリングも実施（2026-04-04）

## セキュリティ / アーキテクチャ課題（新規）

### ~~[高] PKCE が `token.ts` の authorization_code グラントで任意~~ ✅

- **対応済み**: `handleAuthorizationCodeGrant` で `code_challenge` が DB に保存されている場合のみ検証し、コンフィデンシャルクライアント以外（パブリッククライアント）では PKCE を必須化。`code_challenge` なしのリクエストはパブリッククライアントからの場合にエラーを返すよう修正（RFC 7636 §4.4 準拠）

### ~~[高] `/api/token` エンドポイントのレートリミットが IP 単位のみ~~ ✅

- **対応済み**: `RATE_LIMITER_TOKEN` を `client_id` キーでも設定し、IP 単位と二重防御

### ~~[高] `unrevokeRefreshToken` の競合状態~~ ✅

- **対応済み**: `token.ts` のサービス所有権確認・有効期限チェックのパスで `unrevokeRefreshToken` 呼び出し前に `findRefreshTokenByHash` で現在の `revoked_reason` を確認し、`reuse_detected` が設定済みの場合はアンリボークせず `Token reuse detected` を返すよう修正。`auth.ts` の catch ブロックと同様のパターンを追加。テスト2件追加（2026-04-05）

### ~~[中] RFC 7009 (Token Revocation) — アクセストークンの revoke が実装済み~~ ✅

- **対応済み**: `revoked_access_tokens` テーブル（D1）に `jti` を保存し、`introspect` で参照
- migration: `0020_revoked_access_tokens.sql`（⚠️ 本番DB適用要: `npm run migrate:id`）

### ~~[中] `resolveEffectiveScope`: スコープ未指定時に全 allowedScopes を付与~~ ✅

- **対応済み**: スコープ未指定時は `'openid'` のみを返すよう修正（最小スコープポリシー、RFC 6749 §3.3 準拠）。`scopes.test.ts` を新規作成し 14テストを追加（2026-04-05）

### ~~[中] `mcp_sessions` テーブルにユーザーIDが関連付けられていない~~ ✅

- **対応済み**: migration 0021: `user_id` カラム追加、`createMcpSession`/`deleteMcpSessionsByUser` 更新（2026-04-05）

### ~~[中] authMiddlewareにJTIブロックリストチェックが未追加~~ ✅

- **対応済み**: `authMiddleware` で `isAccessTokenRevoked` を呼び出し、revokeされたアクセストークンを即時拒否するよう修正（2026-04-05）

### ~~[中] `isAccessTokenRevoked`: 期限切れレコードを除外するフィルター未適用~~ ✅

- **対応済み**: `expires_at` フィルターを追加し、期限切れのJTIレコードを除外してクエリ効率を改善（2026-04-05）

### ~~[低] 期限切れJTIエントリの定期削除が未実装~~ ✅

- **対応済み**: `cleanupExpiredRevokedAccessTokens` を実装し、scheduledハンドラー（Cron Trigger）に追加。期限切れエントリを自動削除（2026-04-05）

## コードレビュー対応 + テスト修正（2026-04-06）

- [x] **token.ts: 期限切れトークンの `attemptUnrevokeToken` 呼び出し削除**
  - `handleRefreshTokenGrant` で期限切れ時に `attemptUnrevokeToken` を呼んでいたのを削除
  - TODO.md 対応済みとして記録されていたが実装が残っていた状態を修正
  - テスト (`token.test.ts`) との整合性回復
- [x] **テストモック修正: `isAccessTokenRevoked` 未モック問題 (6ファイル)**
  - `authMiddleware` に `isAccessTokenRevoked` が追加されたが、テストモックが未更新だった
  - 影響: `admin-audit-logs`, `auth`, `metrics`, `services`, `users`, `userinfo` テスト全件が 401 を返す誤動作
  - 各ファイルに `isAccessTokenRevoked: vi.fn().mockResolvedValue(false)` を追加
  - `userinfo.test.ts` は `importActual` 方式に変更（`createLogger` 不足も同時解決）
- [x] **テスト追加: BANユーザーのセキュリティテスト**
  - `userinfo.test.ts`: BANユーザーが `/api/userinfo` にアクセスした場合 → 401 を返すテスト追加
  - `external.test.ts`: BANユーザーが `/api/external/users/:sub` で照合された場合 → 404（情報漏洩防止）テスト追加
- [x] **テスト修正: `well-known.test.ts` の `token_endpoint` 期待値**
  - `/auth/exchange`（BFF内部用）→ `/api/token`（RFC 6749準拠）に修正（実装変更との整合）
- 全1452テストパス（変更前: 238失敗 → 変更後: 全パス）

## バグ修正（2026-04-06）

- [x] **well-known: openid-configuration の `authorization_endpoint` が `/auth/login`（BFF専用）を誤って指定**
  - `/auth/authorize`（RFC 6749 準拠の標準 OAuth 2.0 認可エンドポイント）に修正
  - `oauth-authorization-server` は既に `/auth/authorize` を正しく指定していた
  - OIDC Discovery を利用する外部クライアント（MCPクライアント等）が正しい認可エンドポイントを取得できるよう修正
  - `well-known.test.ts` の対応するアサーションも更新（全テストパス）

## 新機能追加（2026-04-06）

- [x] **MCPツール: list_user_sessions / revoke_user_sessions 追加**
  - `list_user_sessions`: 指定ユーザーのアクティブセッション一覧取得（IdPセッション・サービストークン両方含む）
  - `revoke_user_sessions`: 指定ユーザーの全セッション強制失効（admin_action 理由付き + 監査ログ記録）
  - テスト10件追加（users.test.ts: 合計32件）
- [x] **リファクタリング: auth.ts のマジックナンバー `expires_in: 900` を `ACCESS_TOKEN_TTL_SECONDS` 定数に統一**
  - `/auth/exchange` と `/auth/refresh` 両エンドポイントで `token-pair.ts` の既存定数を使用
  - `token.ts` の `buildTokenResponse` との一貫性確保

## ドキュメント更新（2026-04-06, 追記）

- [x] **well-known: claims_supported / response_modes_supported 追加**
  - OIDC Discovery 1.0 Section 3 RECOMMENDED の `claims_supported` フィールドを追加（14クレーム）
  - RFC 8414 準拠の `response_modes_supported: ['query']` を openid-configuration・oauth-authorization-server 両方に追加
  - docs.ts（INTERNAL/EXTERNAL OpenAPI）のスキーマ・例を実装と一致させる
  - well-known.test.ts にテスト2件追加（全12テストパス）

## ドキュメント修正（2026-04-06）

- [x] **docs.ts: well-known エンドポイント記述を実装と一致させる**
  - `authorization_endpoint` の例 `/auth/login` → `/auth/authorize` に修正
  - `token_endpoint` の例 `/auth/exchange` → `/api/token` に修正
  - `token_endpoint_auth_methods_supported` の例 `client_secret_post` → `none` に修正
  - `grant_types_supported` に `device_code` グラントタイプを追加
  - `device_authorization_endpoint` フィールドを追加（INTERNAL/EXTERNAL両仕様）
  - `registration_endpoint`（未実装）を `oauth-authorization-server` から削除

## セキュリティ修正（2026-04-06, 追記）

- [x] **`deleteMcpSessionsByUser` が未使用だったバグを修正**
  - `revokeUserTokens` を呼ぶすべての箇所（BAN・ロール変更・ユーザー削除・全ログアウト・管理者セッション失効・MCP tool）に `deleteMcpSessionsByUser` を追加
  - `mcp_sessions` テーブルに FK 制約がないため、リフレッシュトークン失効後も MCPセッションが最大30分残存するリスクがあった
  - MCP tool `revoke_user_sessions` のテストに `deleteMcpSessionsByUser` 呼び出し検証を追加

## 未対応課題

### ~~[中] introspect時のスコープフォールバック不整合~~ ✅

- **対応済み**: `introspectRefreshToken` / `introspectJwtToken` から `parseAllowedScopes` フォールバックを削除。スコープが null の場合は空文字列を返すよう修正（RFC 7662 §2.2 準拠）。リフレッシュトークンの introspect レスポンスに `token_type: 'refresh_token'` を追加（2026-04-05）

### ~~[中] パブリッククライアントの `client_id` 単位レートリミット欠如~~ ✅

- **対応済み**: `tokenApiClientRateLimitMiddleware` の `getKey` を async 化し、`Authorization: Basic` ヘッダーがない場合はリクエストボディ（urlencoded / JSON両対応）から `client_id` を取得するよう修正。Honoのボディキャッシュ機構により二重読み取りが安全。テスト7件追加（2026-04-05）

### ~~[低] `unrevokeRefreshToken` 失敗時のエラーハンドリング不足~~ ✅

- **対応済み**: リトライ付き（最大2回）のエラーハンドリングを実装。戻り値を boolean に変更し、呼び出し箇所を try-catch で囲んでログ記録。

### ~~[低] `X-Forwarded-For` スプーフィングリスク~~ ✅

- **対応済み**: `getClientIp` から `x-forwarded-for` フォールバックを削除。`cf-connecting-ip` が未設定の場合は `null` を返すよう修正。ローカル開発・Cloudflare設定ミス時はすべてのリクエストが `'unknown'` キーを共有し、`x-forwarded-for` 偽装によるレートリミット回避を防止（2026-04-05）

## 完了済み（Device Code Grant 対応）

- [x] RFC 8628 §3.5: Device Code Grant の `slow_down` レスポンスに `Retry-After` ヘッダーを追加（`device.ts`）
- [x] `device.test.ts` を新規作成し 16テストを追加（RFC準拠・各エラーケース網羅）

## 完了済み

- [x] ~~MCPミドルウェアのBAN/Adminチェック順序修正~~ (2026-04-03, commit 9575641)
- [x] ~~Device Code Grant: approved_at/user_id 不整合防止のCHECK制約追加~~ (2026-04-03, migration 0018)
- [x] ~~管理者ルートにBANチェック追加~~ (2026-04-03, adminMiddleware内でDB確認)
- [x] ~~/auth/exchange, /auth/refresh にService Bindings保護追加~~ (2026-04-03, serviceBindingMiddleware + INTERNAL_SERVICE_SECRET)
- [x] ~~/auth/logout にService Bindings保護追加~~ (2026-04-03, serviceBindingMiddleware適用)
- [x] ~~Device Code user_code ブルートフォース耐性強化~~ (2026-04-03, 認証ユーザー単位レートリミッター追加)
- [x] ~~Service Bindingミドルウェア Basic認証バイパス修正~~ (2026-04-03, authenticateServiceで実際のクライアント認証情報を検証)
- [x] ~~本番環境INTERNAL_SERVICE_SECRET必須化~~ (2026-04-03, HTTPS環境で未設定時にバリデーションエラー)
- [x] ~~既存テストの不備修正（admin-audit-logs, metrics テスト）~~ (2026-04-03, findUserByIdモック追加で全57テストパス)
- [x] ~~使用済み認可コード・デバイスコードの定期クリーンアップ~~ (2026-04-03, Cron Trigger + cleanupExpiredAuthCodes + deleteExpiredDeviceCodes)
- [x] ~~既存テストの不備修正（services, users, admin テスト）~~ (2026-04-03, findUserByIdモック追加+mockResolvedValueOnceチェーンで全1286テストパス)
- [x] ~~Dependabot脆弱性アラート対応（picomatch ReDoS + Method Injection）~~ (2026-04-04, picomatch@4.0.4へアップデート + workers/mcp --passWithNoTests修正)
- [x] ~~authorization_code grantでID token発行（OIDC準拠）~~ (2026-04-04, signIdToken呼び出し追加)
- [x] ~~token exchangeのredirect_uri正規化~~ (2026-04-04, normalizeRedirectUri追加)
- [x] ~~/auth/loginのredirect_uri検証を/auth/authorizeと統一~~ (2026-04-04, matchRedirectUri方式に変更)
- [x] ~~isBffSessionのname空文字チェック追加~~ (2026-04-04)
- [x] ~~fetchWithAuthリフレッシュレスポンスバリデーション追加~~ (2026-04-04)
- [x] ~~MCPセッションTTLをスライディングウィンドウに変更~~ (2026-04-04, lastActiveAt追加)
- [x] ~~MCP list_usersのsearch OR検索対応~~ (2026-04-04, UserFilter.search + buildUserFilterClause)
- [x] ~~MCPセッションのインメモリ管理をD1永続化に変更~~ (2026-04-04, migration 0019 + mcp-sessions.ts + transport.ts書き換え)
- [x] ~~cleanupExpiredMcpSessionsテストのモック修正~~ (2026-04-04, scheduledハンドラテストでvi.mockのモック不備を修正)
- [x] ~~matchRedirectUri query string比較追加~~ (2026-04-04, localhostのポート無視しつつquery stringは厳密比較)
- [x] ~~matchRedirectUri localhost/127.0.0.1 混在対応~~ (2026-04-04, RFC 8252 §8.3 SHOULDに従い同一ホストとして扱う)
- [x] ~~introspect token_type_hint による検索順最適化~~ (2026-04-04, access_token ヒント時はJWT→リフレッシュの順に変更、ヘルパー関数に切り出しリファクタ)
- [x] ~~PKCE が authorization_code グラントで任意（パブリッククライアントで必須化）~~ (2026-04-04, handleAuthorizationCodeGrant でパブリッククライアントへの PKCE 必須化、RFC 7636 §4.4 準拠)
- [x] ~~authMiddlewareにJTIブロックリストチェック追加~~ (2026-04-05, revokeされたアクセストークンを即時拒否)
- [x] ~~isAccessTokenRevoked: expires_atフィルター追加~~ (2026-04-05, 期限切れレコードを除外してクエリ効率改善)
- [x] ~~cleanupExpiredRevokedAccessTokens: 期限切れJTIエントリ定期削除~~ (2026-04-05, scheduledハンドラーに追加)
- [x] ~~well-known: openid-configuration の token_endpoint が /auth/exchange（BFF内部用）を誤って指定~~ (2026-04-05, /api/token に修正・RFC 6749準拠)
- [x] ~~well-known: openid-configuration に device_authorization_endpoint が欠落~~ (2026-04-05, 追加・RFC 8628準拠)
- [x] ~~well-known: openid-configuration に end_session_endpoint が欠落~~ (2026-04-05, 追加・OIDC RP-Initiated Logout準拠)
- [x] ~~well-known: oauth-authorization-server に未実装の registration_endpoint が宣言されていた~~ (2026-04-05, 削除)
- [x] ~~introspect: リフレッシュトークン・JWTトークンのレスポンスに iss・iat が欠落~~ (2026-04-05, 追加・RFC 7662 §2.2準拠)
- [x] ~~期限切れ・失効済みリフレッシュトークンの自動クリーンアップが未実装~~ (2026-04-05, deleteExpiredRefreshTokens + scheduledハンドラーに追加)

## コードレビュー対応済み（2026-04-05）

### セキュリティ修正: unrevokeRefreshToken エラーハンドリング改善

- ✅ `token.ts` / `auth.ts` の `throw e` を RFC 6749 §5.2 準拠の `server_error` JSON レスポンスに変更
- ✅ `unrevokeRefreshToken` の戻り値チェックを追加（`false` 時に `console.error` でログ出力）
- 並行処理でトークン失効解除が失敗した場合の追跡可能性を改善

## リファクタリング対応済み（2026-04-05）

### コード共通化: unrevokeRefreshToken try/catch の共通ユーティリティ抽出

- ✅ `workers/id/src/utils/token-recovery.ts` に `attemptUnrevokeToken(db, tokenId, context)` を新設
- ✅ `token.ts` の3箇所・`auth.ts` の2箇所の重複 try/catch ブロックを `attemptUnrevokeToken` 呼び出しに置換
- メンテナンス性向上・ログ出力の一貫性確保

## コードレビュー対応 (2026-04-05, 追記)

### 対応済み ✅
- **device.ts: normalizeUserCode後の文字セットバリデーション追加**
  - `USER_CODE_CHARS` 以外の文字が含まれる場合に `BAD_REQUEST` を返すよう修正
  - `/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/` によるバリデーション追加

- **device.ts: raw SQL → findServiceById に統一**
  - `/api/device/verify` の inline `prepare/bind/first` を `shared` の `findServiceById` に置き換え

- **device.ts: handleDeviceCodeGrant の空ifブロック修正**
  - `if (approved_at && user_id) { /* 空 */ } else { ... }` を `if (!approved_at || !user_id) { ... }` に反転して可読性改善

- **token.ts: resolveOAuthClient のDB例外時ステータス修正**
  - 例外時の `status: 401` を `status: 500` に修正（DB障害はサーバーエラーとして扱う）

- **token.ts: 未使用import findServiceById を削除**

- **token-recovery.ts: console.error → createLogger('token-recovery') に統一**
  - 他ファイルと同様の構造化ログに変更

---

## コードレビュー対応 (2026-04-05)

### 対応済み ✅
- **期限切れトークンの `attemptUnrevokeToken` 削除** (`token.ts`)
  - 期限切れチェック後に `attemptUnrevokeToken` を呼んで rotation 状態を解除していたが不要かつ危険
  - 期限切れトークンを revoked_at=NULL に戻すと reuse detection ロジックが誤動作するリスク
  - 該当行を削除し、期限切れは `invalid_grant` をそのまま返す挙動に統一

- **`introspectRefreshToken` 失効チェック改善** (`token.ts`)
  - `!refreshToken || revoked_at !== null` を1行で null 返しにしていたのを分離
  - 失効済みトークン（存在はするが revoked）は `{ active: false }` を返すよう修正
  - 「見つからない」と「失効済み」を区別し RFC 7662 §2.2 に準拠

## テストカバレッジ追加（対応済み 2026-04-05）

- [x] ~~`/introspect` — JTIブロックリストhit時に `{ active: false }` を返すことのテスト（`isAccessTokenRevoked` が `true` を返す場合）~~ (2026-04-05)
- [x] ~~`/revoke` — JWTアクセストークンのrevoke（`addRevokedAccessToken` が呼ばれるか、期限内/期限外の分岐）~~ (2026-04-05)
- [x] ~~`/revoke` — JWT署名が無効な場合に 200 OK を返すことのテスト~~ (2026-04-05)
- [x] ~~`/token` (refresh_token grant) — `issueTokenPair` が例外をスローした場合の `server_error` レスポンスのテスト~~ (2026-04-05)
- [x] ~~`/token` (authorization_code grant) — `normalizeRedirectUri` が `null` を返す場合（無効URI）のテスト~~ (2026-04-05)

## コードレビュー指摘事項（未対応）

> 実施日: 2026-04-05

### 中優先度

- [x] ~~`token.ts`: `handleRefreshTokenGrant` でサービス所有権不一致・有効期限切れの両方で `findRefreshTokenByHash` が重複呼び出しされている（D1への余分なクエリ）。1回の呼び出しに統合してパフォーマンス改善~~ (2026-04-05, serviceMismatch/isExpiredを事前評価して条件統合)

### 対応済み（2026-04-05）
- [x] `auth.ts`: `handleProviderLink` のエラーハンドリングが `err.message.includes('UNIQUE constraint failed')` という文字列マッチングに依存 → `linkProvider` 側で UNIQUE制約エラーをキャッチして `PROVIDER_ALREADY_LINKED` として再throw。`handleProviderLink` は完全一致 `=== 'PROVIDER_ALREADY_LINKED'` のみに簡素化
- [x] `token.ts`: `service!` 非null アサーション（`introspect` エンドポイント）削除 → `const introspectService = service` に変数を分離してTypeScript型推論を活用
- [x] `token-pair.ts`: アクセストークンの `expires_in: 900` マジックナンバー → `ACCESS_TOKEN_TTL_SECONDS = 900` 定数として管理

### 低優先度（未対応）

- [x] ~~`token.ts`: RFC 6749 §5.2 準拠 — `invalid_client` で401を返す際に `WWW-Authenticate: Basic realm=\"...\"` ヘッダーが欠落~~ (2026-04-05, c.header()で対応)
- [x] ~~`rate-limit.ts`: `getClientIp` が `null` を返す際のフォールバック `'unknown'` キーで全リクエストが集約されるリスク~~ ✅ (2026-04-05, `key === 'unknown'` 時に warn ログ追加。挙動はX-Forwarded-For偽装防止の意図的設計)
- [x] ~~`middleware/auth.ts`: `rejectBannedUserMiddleware` で削除済みユーザーと停止ユーザーが同じ `UNAUTHORIZED` レスポンスになっている~~ ✅ (2026-04-05, クライアントレスポンスは同一のまま。サーバーサイドで warn ログにより区別可能に)

## 新機能追加（2026-04-06）

- [x] **OAuth 2.0 / OIDC フロー完成: `/auth/authorize` nonce対応 + user BFF OAuth ログインページ追加**
  - `/auth/authorize` に OIDC `nonce` パラメータを追加（最大128文字バリデーション）
  - nonce を `USER_ORIGIN/login` へフォワーディング → auth code に保存 → ID token に埋め込み（OIDC Core 1.0 §3.1.2.1 準拠）
  - `workers/user/src/routes/oauth.ts` を新規作成: `GET /login` プロバイダー選択ページ
    - IdP `/auth/authorize` からリダイレクトされ、全OAuthパラメータを受け取る
    - サーバーサイドで IdP `/auth/login` URLを組み立て（XSS防止）
    - Google / LINE / Twitch / GitHub / X の5プロバイダーに対応
  - `docs.ts` に `/auth/authorize` の OpenAPI ドキュメントを追加
  - テスト12件追加（GET /auth/authorize バリデーション・正常系・nonceフォワーディング）
  - 全1464テストパス

## 対応済み（2026-04-06）

### セキュリティ強化: OAuth/OIDCフロー
- [x] **CSPヘッダー追加**: `workers/user` の OAuth ログインページに `Content-Security-Policy` ヘッダーを追加し、XSS攻撃リスクを低減
- [x] **refresh token グレースピリオド導入**: リフレッシュトークンに30秒のグレースピリオドを設定。ネットワーク遅延等による正常なリトライを許容しつつ、replay attack を防止
- [x] **`end_session_endpoint` を discovery から除外**: OIDC Discovery（`/.well-known/openid-configuration`）から `end_session_endpoint` を除外。未実装エンドポイントをクライアントに公開しないことでセキュリティ上の意図を明確化

### バグ修正: `resolveOAuthClient` のパブリッククライアントパス
- [x] **`token.ts`: `resolveOAuthClient` パブリッククライアントパスに try-catch 追加**
  - DB例外が発生した場合に確実に `status: 500` を返すよう修正
  - 例外をキャッチせずに上位に伝播していたケースを解消し、サーバーエラーとして適切にハンドリング

## バグ修正（2026-04-06, 追記）

- [x] **oauth.ts: `/login` ページの CSP ヘッダー誤設定修正**
  - `style-src 'unsafe-inline'` → `style-src 'self'` に変更（外部CSS `<link>` 読み込みを許可）
  - `img-src 'self'` を追加（ファビコン読み込みを許可）
  - `form-action` ディレクティブを削除（ページにフォーム要素なし）
  - `oauth.test.ts` を新規作成: CSP・バリデーション・HTMLエスケープ 16テスト追加（全1480テストパス）

### 設計方針確認: プロバイダーリゾルバーの現状維持
- [x] **プロバイダーリゾルバーの設計を意図的に維持**
  - 現状: 呼び出し元マップ方式 + 各プロバイダー固有関数（`resolveGoogleProvider`, `resolveLineProvider` 等）
  - 統一化を検討したが、各プロバイダーに固有のロジック（スコープ、トークン形式、APIエンドポイント等）が存在するため統一化は不要と判断
  - 現状の設計を維持することで、プロバイダーごとの柔軟な拡張性を確保

## 2026-04-06 コードレビュー対応

### 対応済み ✅
- ✅ MCPツール `banUserTool`: BANユーザーのリフレッシュトークン・MCPセッション失効を追加 (`workers/mcp/src/tools/users.ts`)
- ✅ MCPツール `deleteUserTool`: 削除前に存在確認・トークン失効・MCPセッション削除を追加 (`workers/mcp/src/tools/users.ts`)
- ✅ `token.ts` グレースピリオド: 条件判定を `auth.ts` と統一（`>` → `<` に修正）

### 未対応（今後対応予定）
- ~~`oauth-authorization-server` エンドポイント (RFC 8414) に `claims_supported` / `response_modes_supported` / `subject_types_supported` が未追加（OIDCディスカバリの一貫性）~~ ✅ (2026-04-06, subject_types_supported / claims_supported 追加、テスト4件追加)
- ~~CSPヘッダーに `script-src 'none'` を明示的に追加（`default-src 'none'` からの意図明確化）~~ ✅ (2026-04-06)
- ~~SQLite `datetime('now')` → `strftime('%Y-%m-%dT%H:%M:%SZ', 'now')` でISO 8601準拠に（Node.jsテスト環境での `new Date()` パース互換性）~~ ✅ (2026-04-06, commit a9d8f25)
- ~~nonce 形式バリデーション（長さのみ → 制御文字等の排除も検討）~~ ✅ (2026-04-06, \\x00-\\x1F, \\x7F を拒否)
- ~~テスト網羅: グレースピリオドのエッジケース（BAN済みユーザー再BAN等）~~ ✅ (2026-04-06, グレースピリオド内TOKEN_ROTATED + revoked_at null の2ケースを auth.test.ts / token.test.ts に追加)

## テストカバレッジ追加（2026-04-07）

- ✅ **`workers/user/src/routes/device.ts` のテストカバレッジ追加**
  - `/api/device/verify`（ユーザーコード検証）・`/api/device/approve`（承認/拒否）のテスト22件追加
  - 認証なし・不正ボディ・不正user_code形式・IdP到達不能・成功系・各種エラーコード引き継ぎを網羅
  - `toUpperCase()` による小文字入力の自動変換動作もテストで明示
  - 全1525テストパス

## リファクタリング（2026-04-07）

- ✅ **`parseJsonBody` の import を shared 版に統一**
  - `workers/id/src/routes/{auth,services,users}.ts` の import を `../utils/parse-body` → `@0g0-id/shared` に変更
  - ローカルコピー `workers/id/src/utils/parse-body.ts` を削除（重複解消）
  - テストの `vi.mock('@0g0-id/shared')` に `importOriginal` 経由で実際の `parseJsonBody` を追加
  - 全1501テストパス

## セキュリティ強化（2026-04-06, コードレビュー起因）

- ✅ **`parseAllowedScopes`: スコープ文字種バリデーション追加**
  - `VALID_SCOPE_RE = /^[\\w:.\\-]+$/` を追加し、空白・制御文字を含む要素を除外
  - 悪意あるスコープ文字列（スペース混入、制御文字）がサービス設定に混入するリスクを排除
  - RFC 6749 §3.3 準拠
- ✅ **`validateNonce` 関数を `scopes.ts` に追加 + nonce バリデーション共通化**
  - `/auth/authorize` と `/auth/login` の両ハンドラで重複していた nonce バリデーション（長さ128文字・制御文字チェック）を `validateNonce` に統合
  - 重複ロジックによる乖離リスクを解消
  - テスト追加（`scopes.test.ts`: 計21テスト、全1501テストパス）

## バグ修正（2026-04-06, コードレビュー起因）

- ✅ **token-pair.ts: `scope ?? null` → `scope || null`**
  - `??` はnull/undefinedのみnullに落とすが、空文字列 `''` はfalsy判定されず通過していた
  - `||` に変更することで空文字列もnullに落とし、DBへの空文字列保存を防止
- ~~`auth.ts: POST /refresh の不要なDB再クエリ削除`~~ → **バグだったため revert・修正済み（2026-04-07）**
  - `findAndRevokeRefreshToken` の `RETURNING *` は更新後の値を返すため `storedToken.revoked_reason` は常に `'rotation'`
  - `storedToken.revoked_reason === 'reuse_detected'` チェックは dead code だった（race condition 検知不能）
  - `token.ts` と同じパターン（`findRefreshTokenByHash` 再クエリ）に修正、エラーログも追加
  - テスト2件追加（issueTokenPair失敗時のreuse_detected競合 + 通常エラー）

## コードレビュー対応（2026-04-07, 追記）

- ✅ **device.ts: POST /api/device/verify の action 早期バリデーション**
  - `action` が `'approve'`/`'deny'` 以外の不正値のとき、DB問い合わせより前に 400 を返すよう修正
  - 不要な `findDeviceCodeByUserCode` クエリを排除し、後続の重複チェックを削除
- ✅ **rate-limit.ts: `warnedBindings` コメントを Cloudflare Workers isolate の実態に合わせて修正**
  - 「1ワーカーインスタンスにつき1回」→ isolate内リクエスト間で状態共有・コールドスタートでリセットされる旨を明記

## 2026-04-07（コードレビュー対応）

### ✅ 対応済み
- **バグ修正: `createAuthCode` 例外未キャッチ** (`workers/id/src/routes/auth.ts`)
  - `/auth/callback` の `createAuthCode` 呼び出しが try/catch なし → D1 書き込み失敗時に 500 エラー
  - try/catch で包み、失敗時に `{ error: 'server_error' }` を返すよう修正
- **セキュリティ修正: `/introspect` 401 時の `WWW-Authenticate` ヘッダー追加** (`workers/id/src/routes/token.ts`)
  - RFC 7662 §2.2 準拠のため `WWW-Authenticate: Bearer realm=\"0g0-id\"` を追加

### 未対応（次回対応候補）
- ~~**token.ts**: `handleRefreshTokenGrant` で service_id ミスマッチ後の `attemptUnrevokeToken` に `reuse_detected` チェック漏れ → 並行リクエストでトークン状態が矛盾する可能性~~ ✅ **対応済み（2026-04-07）**
  - `findRefreshTokenById` を shared に追加し、`attemptUnrevokeToken` で unrevoke 前に `reuse_detected` チェックを実施するよう修正
- ~~**auth.ts**: Cookie の `stateData` に署名がない（理論上の改ざんリスク）~~ ✅ **対応済み（2026-04-07）**
  - `packages/shared/src/lib/cookie.ts` に `signCookie` / `verifyCookie`（HMAC-SHA256、WebCrypto API）を追加
  - `IdpEnv` に `COOKIE_SECRET: string` を追加、`auth.ts` の stateData 設定・読み取りを署名付き Cookie に移行
  - 署名検証失敗時は 400 を即時返却。デプロイ時は `wrangler secret put COOKIE_SECRET` が必要
- ~~**oauth.ts**: クライアントパラメータ（state, scope 等）の長さ検証なし~~ ✅ **対応済み（2026-04-07）**
  - 全クエリパラメータ（client_id: 128, redirect_uri: 2048, state: 2048, code_challenge: 256, code_challenge_method: 16, scope: 1024, nonce: 2048）に長さ上限チェックを追加
  - 上限超過時は 400 Bad Request を返す（DoS・過大入力対策）

## 2026-04-07 コードレビュー対応②

### auth.ts 期限切れトークン unrevoke 削除（✅ 対応済み）

**問題**: `POST /auth/refresh` エンドポイントで、期限切れトークンに対して `attemptUnrevokeToken` を呼んでいた。`token.ts` の `handleRefreshTokenGrant` では意図的に削除済みの呼び出しが残存していた。

**修正内容**:
- 期限切れ時の `attemptUnrevokeToken` 呼び出しを削除
- コメントを `token.ts` の意図と揃えて更新
- これにより、失効済み期限切れトークンの再提示で reuse detection が正しく機能するようになる

### auth.ts link-intent エラーハンドリング追加（✅ 対応済み）

**問題**: `/auth/link-intent` エンドポイントで `createAuthCode` が try/catch なしで呼ばれており、D1 書き込み失敗時に 500 エラーが素通りしていた。

**修正内容**:
- `createAuthCode` を try/catch で囲み、失敗時に `INTERNAL_ERROR` 500 を返すように修正
- `/auth/callback` の対応（2026-04-07 対応①）と挙動を統一

---

## コードレビュー対応（2026-04-07）

### resolveXProvider isPlaceholderEmail フラグ追加（✅ 対応済み）

**問題**: `resolveXProvider` で `upsertXUser` に `isPlaceholderEmail` フラグを渡していなかった。LINE/GitHub/Twitch等では `isPlaceholderEmail: true` を渡して `emailLink` と `newUserEmailVerified` を制御しているが、X（Twitter）では漏れていた。

**修正内容**:
- `upsertXUser` 呼び出しに `isPlaceholderEmail: true` を追加（`workers/id/src/routes/auth.ts`）
- `packages/shared/src/db/users.ts` の `upsertXUser` params型に `isPlaceholderEmail: boolean` を追加し処理を統一
- 関連テスト3件を更新（`packages/shared/src/db/users.test.ts`）

### GET /auth/callback の provider フォールバック削除（✅ 対応済み）

**問題**: `stateData.provider ?? 'google'` という実装があり、Cookie内にproviderフィールドがない場合に誤ってgoogleプロバイダーとして処理されるリスクがあった。

**修正内容**:
- `stateData.provider` が未定義の場合は `BAD_REQUEST: 'Missing provider in state'` を返すように変更
- Cookie署名検証済みであっても、不正フォーマットへの防御的処理として適切

### ip.ts 単体テスト追加（✅ 対応済み）

**問題**: `workers/id/src/utils/ip.ts` の `getClientIp` 関数にテストファイルが存在しなかった。

**修正内容**:
- `workers/id/src/utils/ip.test.ts` を新規作成、5件のテスト追加
- CF-Connecting-IP優先・ヘッダーなし時のnull返却・XFF単体はnull・IPv6対応を確認

**テスト総数**: 720件（715 → 720）

## 2026-04-07 コードレビュー対応（token.ts）

### 対応済み ✅
- `/revoke` JWT_PATTERNマッチ時のリフレッシュトークン失効スキップバグ修正
  - JWT検証失敗時もリフレッシュトークン処理へフォールスルーするよう修正
- `handleAuthorizationCodeGrant` 例外処理追加
  - `issueTokenPair` / `signIdToken` 例外時に 500 server_error を返すよう修正
- 上記2件のテスト追加（計91テスト）

### 対応済み ✅
- ~~`resolveEffectiveScope` が undefined 返却時のスコープ空トークン発行問題~~ → `invalid_scope` + 400 を返すよう修正（token.ts / auth.ts / device.ts 3箇所、テスト+11件、1602テストパス）

### 未対応・今後検討 📝
- ~~`introspectRefreshToken` / `introspectJwtToken` 内部の例外処理追加（DB障害時に active: false を返すべき）~~ ✅ **対応済み（2026-04-07）**
  - 両関数に try/catch を追加、DB障害時は `tokenLogger.error` でログ出力し `{ active: false }` を返す
  - テスト3件追加（findRefreshTokenByHash例外・isAccessTokenRevoked例外・findUserById例外）
- ~~パブリッククライアント判定ロジックの分散（`resolveOAuthClient` 戻り値にクライアント種別を含める）~~ ✅ **対応済み（2026-04-08）**
  - `resolveOAuthClient` の `ok: true` 戻り値に `isPublicClient: boolean` を追加
  - Confidentialクライアントは `isPublicClient: false`、Publicクライアントは `isPublicClient: true`
  - `handleAuthorizationCodeGrant` での重複判定（`!c.req.header('Authorization')?.startsWith('Basic ')`）を削除
- ✅ `handleAuthorizationCodeGrant` / `handleRefreshTokenGrant` の型定義冗長化（型エイリアス導入）
  - `TokenHandlerContext` 型エイリアスを `token.ts` に追加し、両関数のインライン型定義を置き換え（2026-04-09）
- ✅ `/revoke` でJWT形式のリフレッシュトークン（JWT_PATTERNマッチ、JWT検証失敗）のテスト補強（5件追加: DB不存在・失効済み・他サービス所有・jtiなし・cid不一致）

## 2026-04-09 追加対応 ✅

### コードレビュー: token.ts エラーハンドリング修正

#### バグ修正1: `addRevokedAccessToken()` の try-catch 漏れ（revoke エンドポイント）
- **問題**: `/token/revoke` で `verifyAccessToken()` と `addRevokedAccessToken()` が同一 try ブロックに入っており、DB エラー時に `jwtVerified=false` のまま RT 処理へフォールスルーし 200 OK が返るバグがあった
- **修正**: `verifyAccessToken()` の try を分離し、`addRevokedAccessToken()` は独立した try-catch で囲み DB エラー時に 500 を返すよう変更
- **コミット**: c0654b3

#### バグ修正2: `introspectRefreshToken()` / `introspectJwtToken()` RFC 7662 非準拠
- **問題**: DB エラー時に `{ active: false }` を返しており、トークン無効とサーバーエラーの区別がつかなかった
- **修正**: DB エラー時は `throw err` で伝播し、ルートハンドラで 500 + `{ error: 'server_error' }` を返すよう変更（RFC 7662 §2.2 準拠）
- **テスト更新**: 旧挙動を期待していた 3 件のテストを新挙動に合わせて修正
- **コミット**: c0654b3

## 完了済み（2026-04-09）

- ✅ **`routes/token.ts`: `POST /revoke` リフレッシュトークン処理に try/catch 追加（D1トランジェントエラー対策）**

- ✅ **`routes/token.ts`: `/introspect` サービス認証失敗レスポンスを `{ active: false }` → `{ error: 'invalid_client' }` に修正（RFC 7662 §2.3準拠）**

- ✅ **`routes/device.ts`: `handleDeviceCodeGrant` のパラメータ型を ad-hoc → `TokenHandlerContext` に統一**

- ✅ **`routes/auth.ts`: `/exchange` ユーザー未発見時を 404 → 400 (`invalid_grant`) に修正（OAuth 2.0準拠）**

- `auth.ts`: `ExchangeSchema` の `code_verifier` に RFC 7636 §4.1 準拠の文字セット検証（`[A-Za-z0-9\-._~]`）追加 ✅
- `token.ts`: `handleRefreshTokenGrant` のスコープ空文字列フォールバック（`?? ''`）を削除（`auth.ts` と整合） ✅
- `token.ts`: `introspectRefreshToken` の `service_id` 不一致時にセキュリティ警告ログ追加 ✅
- `metrics.test.ts`: `parseDays` モックの戻り値を明示設定してテスト修正（全821テストパス） ✅

## 2026-04-09 コードレビュー (auth.ts)

### 完了
- ✅ `routes/auth.ts`: `/auth/callback` の state Cookie 検証・パースを `parseStateFromCookie` ヘルパーに抽出
  - `verifyCookie` → `JSON.parse` → フィールド検証の責務を一元化
  - ネスト3段 → 1段に整理
  - テスト: 111 passed

### 残課題（優先度順）

#### 優先度1
- ✅ `routes/auth.ts`: プロバイダー認証情報（OPTIONAL_PROVIDER_CREDENTIALS）を `packages/shared` の PROVIDER_CREDENTIALS として一元管理化（2026-04-09）
  - `packages/shared/src/lib/providers.ts` に `PROVIDER_CREDENTIALS` を追加・export
  - `auth.ts` のローカル定義を削除し `@0g0-id/shared` からのインポートに変更
  - 新プロバイダー追加時は `providers.ts` だけ更新すれば良い状態に
  - テストモックに `PROVIDER_CREDENTIALS`・`COOKIE_SECRET` を追加（840テストパス）

#### 優先度2
- ✅ `routes/auth.ts`: プロバイダーごとの `resolve*Provider` 関数の重複削減（2026-04-09）
  - `resolveGoogleProvider` / `resolveLineProvider` / `resolveTwitchProvider` / `resolveGithubProvider` / `resolveXProvider` の5関数を廃止
  - 単一の `resolveProvider(c, provider, code, pkceVerifier, callbackUri)` に統合し switch/case で管理
  - `/auth/callback` の `resolvers` マップも削除（7行削減）
- ✅ `routes/auth.ts`: `link_token` の署名方式を SHA-256 ハッシュから HMAC 署名 Cookie パターンに変更（2026-04-09）
  - `/link-intent`: `generateToken` + `sha256` + `createAuthCode` → `signCookie({ sub, exp })` に置換（DBアクセス不要）
  - `/login` link_token検証: `sha256` + `findAndConsumeAuthCode` → `verifyCookie` + JSON.parse + 期限チェックに置換
  - テスト: 期限切れlink_token→400テスト追加、createAuthCode呼び出し確認を削除（840テストパス）

#### 優先度3（設計改善）
- ✅ `routes/auth.ts`: bootstrap admin 昇格失敗時の挙動を改善（2026-04-09）
  - 修正: DB例外時に `{ error: { code: 'INTERNAL_ERROR' } }` 500 を返すよう変更（silent failureを排除）
  - テスト: DB例外→500ケース追加（全841テストパス）

## 2026-04-10 テストカバレッジ追加: logger・parse-body・body-limit

### 追加したテスト

#### packages/shared/src/lib/logger.test.ts ✅
- `createLogger` でロガーインスタンス生成を確認
- info/debug ログが `console.log` に JSON 形式で出力される
- warn ログが `console.warn` に出力される
- error ログが `console.error` に出力される
- `Error` オブジェクトを渡すと `err`・`stack` が設定される
- 非 Error オブジェクトを渡すと `data` に設定される
- extra なし → `data`/`err`/`stack` が含まれない
- コンテキスト文字列が出力に反映される
- 数値・null を extra として渡すと `data` に設定される
- 計 11テスト

#### packages/shared/src/lib/parse-body.test.ts ✅
- 有効な JSON ボディをパースして data を返す
- 不正な JSON ボディ → 400 BAD_REQUEST
- Zod バリデーション失敗 → 400 BAD_REQUEST
- 必須フィールド欠如 → 400
- 空オブジェクト → 400
- スキーマ通過時は ok: true と data を返す
- 型が違うフィールド → 400
- null ボディ → 400
- 計 8テスト

#### packages/shared/src/middleware/body-limit.test.ts ✅
- デフォルト 64KB 以下のボディは通過する
- デフォルト 64KB 超 → 413 PAYLOAD_TOO_LARGE
- カスタムサイズ: 100B 以下は通過する
- カスタムサイズ: 100B 超 → 413
- GET リクエストはボディ制限の対象外
- 空ボディは通過する
- 計 6テスト

## 2026-04-10 テストカバレッジ追加: /me/login-stats・/me/login-trends

### 追加したテスト

#### workers/id/src/routes/users.test.ts ✅
- `GET /api/users/me/login-stats`: 認証なし→401、統計+days返却、自分のsubで呼び出し確認、daysクエリパラメータ、範囲外days→400
- `GET /api/users/me/login-trends`: 認証なし→401、トレンド+days返却、自分のsubで呼び出し確認、daysクエリパラメータ、範囲外days→400
- 計 10テスト追加（867 → 877件）

## 2026-04-10 機能追加: MCPツール get_user_login_stats・get_user_login_trends

### 追加したツール

#### workers/mcp/src/tools/users.ts ✅
- `getUserLoginStatsTool` (`get_user_login_stats`): ユーザーのプロバイダー別ログイン統計を取得（days パラメータ対応、デフォルト30日、最大365日）
- `getUserLoginTrendsTool` (`get_user_login_trends`): ユーザーの日別ログイントレンドを取得（days パラメータ対応、デフォルト30日、最大365日）
- 両ツール: user_id 未指定・空文字→エラー、ユーザー未存在→404エラー
- テスト: 各5件追加（計+10件、132 → 142件）

## 2026-04-10 機能追加: MCPツール get_suspicious_logins・get_service_token_stats

### 追加したツール

#### workers/mcp/src/tools/metrics.ts ✅
- `getSuspiciousLoginsTool` (`get_suspicious_logins`): 複数国からの短時間ログインを検出（hours 1〜168、min_countries 2〜10、デフォルト24h/2か国）
- `getServiceTokenStatsTool` (`get_service_token_stats`): 全サービスのアクティブトークン統計（認可ユーザー数・トークン数）を取得
- テスト: 各4・3件追加（計+9件、142 → 151件）

## 2026-04-11 bff.ts 未テスト関数テスト22件追加

### 変更ファイル
- `packages/shared/src/lib/bff.test.ts` — テスト13件 → 35件（+22件）

### 追加したテスト（7つのdescribeブロック）
- `encodeSession` — 4件: base64url形式確認・parseSessionで復元可能・ランダムIV・異なるシークレット
- `setSessionCookie` — 2件: setCookieの正しいオプション（httpOnly/secure/Lax/30日）・Cookie値の復元確認
- `internalServiceHeaders` — 2件: INTERNAL_SERVICE_SECRET設定時/未設定時の挙動
- `setOAuthStateCookie` — 1件: maxAge=600のCookie設定確認
- `verifyAndConsumeOAuthState` — 3件: missing_session/state_mismatch/null（成功+Cookie削除）
- `exchangeCodeAtIdp` — 3件: 成功時ExchangeResult返却・失敗時ok:false・X-Internal-Secretヘッダー付与
- `revokeTokenAtIdp` — 2件: /auth/logoutへのPOST確認・X-Internal-Secretヘッダー付与
- `proxyMutate` — 3件: DELETE（デフォルト）/PATCH転送・セッションなし時401

### テスト数推移
- 変更前: 2016件パス
- 変更後: 2038件パス（+22件）

## テストカバレッジ追加（2026-04-11）

- ✅ **`refresh-tokens.test.ts`: 未テスト6関数のユニットテスト24件追加**
  - `findRefreshTokenById`: id検索・null返却・bindパラメータ確認（3件）
  - `findAndRevokeRefreshToken`: revoke成功・既失効null・reason有無・RETURNING * SQL確認（5件）
  - `unrevokeRefreshToken`: true/false返却・DB例外リトライ・SQL条件確認（4件）
  - `deleteExpiredRefreshTokens`: 削除件数・0件・DELETE SQL確認（3件）
  - `findUserIdByPairwiseSub`: user_id返却・null・bindパラメータ・SQL条件確認（4件）
  - `revokeTokenByIdForUser`: 件数・0件・reason有無・SQL条件確認（5件）
  - packages/shared: 625 → 649テスト（+24）、全2087テストパス

## テストカバレッジ追加（2026-04-11）

### 追加したテスト

#### packages/shared/src/db/auth-codes.test.ts ✅
- `cleanupExpiredAuthCodes`: 期限切れ・使用済みエントリ削除件数返却・削除0件・DELETE SQL条件確認・meta.changes undefined→0
- 計 4テスト（packages/shared: 649 → 653テスト、全2095テストパス）
